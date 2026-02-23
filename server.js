require('dotenv').config();
const express = require('express');
const multer = require('multer');
// const unzipper = require('unzipper'); // HAPUS INI
const AdmZip = require('adm-zip');      // GANTI DENGAN INI
const axios = require('axios');
const simpleGit = require('simple-git');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

const isVercel = process.env.VERCEL === '1';
const uploadDir = isVercel ? '/tmp/uploads' : 'uploads/';
if (!isVercel) fs.ensureDirSync(uploadDir);
const upload = multer({ dest: uploadDir });
// --- HELPER FUNCTIONS ---

async function getGithubUser(token) {
    try {
        const response = await axios.get('https://api.github.com/user', {
            headers: { 
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        return response.data;
    } catch (error) {
        throw new Error("Gagal mendapatkan data user. Token mungkin salah.");
    }
}

async function flattenDirectory(dirPath) {
    try {
        const items = await fs.readdir(dirPath);
        // Filter sampah sistem
        const validItems = items.filter(item => 
            !['.DS_Store', '__MACOSX', 'Thumbs.db', '.git'].includes(item)
        );

        // Jika cuma ada 1 folder di dalam hasil ekstrak (misal: MyProject/), ratakan!
        if (validItems.length === 1) {
            const singleItemName = validItems[0];
            const singleItemPath = path.join(dirPath, singleItemName);
            const stat = await fs.stat(singleItemPath);

            if (stat.isDirectory()) {
                console.log(`[Flatten] Meratakan folder: '${singleItemName}'...`);
                const tempMoveDir = path.join(dirPath, '..', `temp_move_${Date.now()}`);
                
                // Pindah folder anak ke temp
                await fs.move(singleItemPath, tempMoveDir);
                // Bersihkan folder induk
                await fs.emptyDir(dirPath);
                // Balikin isi temp ke folder induk
                await fs.copy(tempMoveDir, dirPath);
                // Hapus temp
                await fs.remove(tempMoveDir);
                console.log('[Flatten] Sukses.');
            }
        }
    } catch (error) {
        console.error('[Flatten Error] Gagal meratakan folder:', error.message);
    }
}

function getFriendlyErrorMessage(error, repoName) {
    if (error.response) {
        const status = error.response.status;
        if (status === 422) return `Nama repository '${repoName}' sudah digunakan/invalid.`;
        if (status === 401) return "Token GitHub salah.";
    }
    if (error.message && error.message.includes('git')) {
        return "Gagal operasi Git. Cek koneksi internet.";
    }
    return error.message || "Terjadi kesalahan sistem.";
}

// --- ROUTE DEPLOY ---

app.post('/deploy', upload.single('projectZip'), async (req, res) => {
    let { repoName, visibility, githubToken } = req.body;
    
    if (repoName) {
        repoName = repoName.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '');
    }

    if (!repoName || !githubToken || !req.file) {
        if (req.file) await fs.remove(req.file.path);
        return res.status(400).json({ error: 'Data tidak lengkap.' });
    }

    const zipPath = req.file.path;
    const baseDir = isVercel ? '/tmp/extracted' : path.join(__dirname, 'extracted');
    const workDir = path.join(baseDir, `${Date.now()}_${repoName}`);

    try {
        // 1. Validasi GitHub
        const user = await getGithubUser(githubToken);
        const username = user.login;
        const userEmail = user.email || `${username}@users.noreply.github.com`;
        const remoteUrl = `https://${githubToken}@github.com/${username}/${repoName}.git`;
        const repoHtmlUrl = `https://github.com/${username}/${repoName}`;

        let isUpdateMode = false;

        // 2. Cek apakah Repo sudah ada
        try {
            console.log(`Mencoba membuat repo: ${repoName}...`);
            await axios.post('https://api.github.com/user/repos', 
                { name: repoName, private: visibility === 'private', auto_init: false },
                { headers: { 'Authorization': `token ${githubToken}`, 'Accept': 'application/vnd.github.v3+json' } }
            );
        } catch (err) {
            if (err.response && err.response.status === 422) {
                console.log('Repository sudah ada. Beralih ke MODE UPDATE.');
                isUpdateMode = true;
            } else {
                throw err;
            }
        }

        // 3. Persiapkan Folder Kerja
        await fs.emptyDir(workDir);

        // 4. EKSTRAK ZIP (MENGGUNAKAN ADM-ZIP - LEBIH STABIL)
        console.log('Mengekstrak file project...');
        try {
            const zip = new AdmZip(zipPath);
            zip.extractAllTo(workDir, true); // true = overwrite
        } catch (zipErr) {
            throw new Error("File ZIP rusak atau gagal diekstrak.");
        }

        // 5. Ratakan Folder
        await flattenDirectory(workDir);
        
        // Debugging: Cek file apa saja yang berhasil diekstrak
        const filesAfterExtract = await fs.readdir(workDir);
        console.log('File berhasil diekstrak:', filesAfterExtract.join(', '));

        // 6. AUTO-IGNORE NODE_MODULES (Sangat Penting!)
        // Mengecek apakah ada folder node_modules
        if (filesAfterExtract.includes('node_modules')) {
            console.log('⚠️ Mendeteksi node_modules. Menambahkan ke .gitignore agar upload cepat...');
            const gitignorePath = path.join(workDir, '.gitignore');
            
            // Tambahkan rule ignore node_modules
            await fs.appendFile(gitignorePath, '\nnode_modules/\n.env\n');
            
            // (Opsional) Hapus node_modules fisik agar Git tidak bingung/berat saat inisialisasi awal
            // await fs.remove(path.join(workDir, 'node_modules')); 
            // ^ Uncomment baris di atas jika ingin menghapus fisik node_modules sebelum push
        }

        // 7. SETUP GIT
        const git = simpleGit(workDir);
        
        // Fix Android Permission
        await git.addConfig('safe.directory', workDir, true, 'global');

        await git.init();
        await git.addRemote('origin', remoteUrl);
        await git.addConfig('user.name', username);
        await git.addConfig('user.email', userEmail);

        let branchName = 'master'; 

        if (isUpdateMode) {
            console.log('Mode Update: Sinkronisasi Git...');
            await git.fetch('origin');
            
            const branches = await git.branch(['-r']);
            if (branches.all.includes('origin/main')) branchName = 'main';

            try {
                // Reset history tapi simpan file baru kita
                await git.reset(['--mixed', `origin/${branchName}`]);
            } catch (resetErr) {
                console.log('Reset skip (Repo mungkin kosong).');
            }
        } else {
            await git.branch(['-M', 'master']);
        }

        // 8. GIT ADD & COMMIT
        console.log('Menambahkan file ke Git...');
        await git.add(['-A', '.']); // Tambahkan semua
        
        const status = await git.status();

        if (status.files.length === 0) {
            console.log('Tidak ada perubahan file.');
            await fs.remove(zipPath);
            await fs.remove(workDir);
            return res.json({ 
                success: true, 
                message: 'Repository sudah up-to-date.', 
                repoUrl: repoHtmlUrl,
                noChanges: true 
            });
        }

        console.log(`Mendeteksi ${status.files.length} perubahan. Committing...`);
        const commitMessage = isUpdateMode ? `Update: ${new Date().toLocaleString()}` : 'Initial commit';
        
        await git.commit(commitMessage);

        console.log(`Pushing ke ${branchName}...`);
        await git.push(['-u', 'origin', branchName]);

        // Cleanup
        console.log('Selesai.');
        await fs.remove(zipPath);
        await fs.remove(workDir);

        res.json({ success: true, message: 'Berhasil deploy!', repoUrl: repoHtmlUrl });

    } catch (error) {
        console.error('Error Process:', error);
        
        if (fs.existsSync(zipPath)) await fs.remove(zipPath);
        if (fs.existsSync(workDir)) await fs.remove(workDir);

        const simpleMessage = getFriendlyErrorMessage(error, repoName);
        res.status(500).json({ success: false, error: simpleMessage });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});
