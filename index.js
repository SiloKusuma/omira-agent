require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ytdl = require('ytdl-core');

const token = process.env.TELEGRAM_TOKEN;
const groqApiKey = process.env.GROQ_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'llama-3.1-70b-versatile';
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID || '7431243392';
const WORKING_DIR = process.env.WORKING_DIR || process.cwd();

if (!token) {
    console.error('Error: TELEGRAM_TOKEN tidak ditemukan di file .env');
    process.exit(1);
}

if (!groqApiKey) {
    console.error('Error: GROQ_API_KEY tidak ditemukan di file .env');
    process.exit(1);
}

const openai = new OpenAI({
    apiKey: groqApiKey,
    baseURL: 'https://api.groq.com/openai/v1'
});

const bot = new TelegramBot(token, { polling: true });

function escapeMarkdown(text) {
    if (!text) return '';
    return String(text).replace(/[\`*_{}[\]()>#+.!]/g, '\\$&');
}

const userState = {};
const openTabs = [];
const MEMORY_FILE = path.join(WORKING_DIR, 'memory.json');
const activeVideos = {};

const platform = os.platform();
let osType = 'Unknown';
if (platform === 'win32') osType = 'Windows';
else if (platform === 'darwin') osType = 'macOS';
else if (platform === 'linux') osType = 'Linux';

console.log(`🤖 Omira AI Agent dimulai...`);
console.log(`💻 Sistem Operasi: ${osType}`);
console.log(`📁 Working Directory: ${WORKING_DIR}`);
console.log(`🤖 AI Model: ${AI_MODEL}`);
console.log(`🔐 User ID yang diizinkan: ${ALLOWED_USER_ID}`);
console.log(`📱 Bot Telegram siap menerima pesan...`);

function isAllowedUser(chatId) {
    return chatId.toString() === ALLOWED_USER_ID;
}

function loadMemory() {
    return new Promise((resolve) => {
        if (!fs.existsSync(MEMORY_FILE)) {
            fs.writeFileSync(MEMORY_FILE, JSON.stringify({ user_info: {}, facts: [], preferences: {} }, null, 2));
            resolve({ user_info: { name: 'User', nickname: null }, facts: [], preferences: {} });
            return;
        }
        try {
            const data = fs.readFileSync(MEMORY_FILE, 'utf8');
            const memory = JSON.parse(data);
            resolve(memory);
        } catch (e) {
            resolve({ user_info: { name: 'User', nickname: null }, facts: [], preferences: {} });
        }
    });
}

function saveMemory(memory) {
    return new Promise((resolve) => {
        fs.writeFile(MEMORY_FILE, JSON.stringify(memory, null, 2), 'utf8', (err) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true });
            }
        });
    });
}

function memoryToText(memory) {
    let text = '';
    
    if (memory.user_info) {
        if (memory.user_info.name) {
            text += `- Nama user: ${memory.user_info.name}\n`;
        }
        if (memory.user_info.nickname) {
            text += `- Panggilan sayang: ${memory.user_info.nickname}\n`;
        }
        if (memory.user_info.occupation) {
            text += `- Pekerjaan: ${memory.user_info.occupation}\n`;
        }
        if (memory.user_info.location) {
            text += `- Lokasi: ${memory.user_info.location}\n`;
        }
    }
    
    if (memory.facts && memory.facts.length > 0) {
        text += `\nFakta penting tentang user:\n`;
        memory.facts.forEach((fact, i) => {
            text += `${i + 1}. ${fact}\n`;
        });
    }
    
    if (memory.preferences) {
        const prefs = Object.entries(memory.preferences);
        if (prefs.length > 0) {
            text += `\nPreferensi user:\n`;
            prefs.forEach(([key, value]) => {
                text += `- ${key}: ${value}\n`;
            });
        }
    }
    
    return text.trim();
}

function extractYouTubeVideoId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
        /^[a-zA-Z0-9_-]{11}$/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

function isYouTubeUrl(url) {
    return extractYouTubeVideoId(url) !== null;
}

function extractYouTubeUrlFromText(text) {
    if (!text) return null;
    
    const patterns = [
        /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+[^\s]*/,
        /https?:\/\/youtu\.be\/[a-zA-Z0-9_-]+[^\s]*/,
        /https?:\/\/(?:www\.)?youtube\.com\/embed\/[a-zA-Z0-9_-]+[^\s]*/,
        /https?:\/\/(?:www\.)?youtube\.com\/v\/[a-zA-Z0-9_-]+[^\s]*/,
        /https?:\/\/m\.youtube\.com\/watch\?v=[a-zA-Z0-9_-]+[^\s]*/,
        /https?:\/\/www\.youtube\.com\/shorts\/[a-zA-Z0-9_-]+[^\s]*/
    ];
    
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            const url = match[0].split('&')[0].split('?')[0];
            return url;
        }
    }
    return null;
}

function containsYouTubeUrl(text) {
    return extractYouTubeUrlFromText(text) !== null;
}

async function getYouTubeVideoInfo(url) {
    try {
        const videoId = extractYouTubeVideoId(url);
        if (!videoId) {
            return { success: false, error: 'Invalid YouTube URL' };
        }
        
        const info = await ytdl.getInfo(url);
        
        const videoDetails = {
            title: info.videoDetails.title,
            description: info.videoDetails.description,
            duration: info.videoDetails.lengthSeconds,
            thumbnail: info.videoDetails.thumbnails?.[0]?.url || '',
            videoId: videoId,
            url: url
        };
        
        return { success: true, info: videoDetails };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function formatDuration(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function resolvePath(targetPath) {
    if (!targetPath) return null;
    if (path.isAbsolute(targetPath)) {
        return targetPath;
    }
    return path.resolve(WORKING_DIR, targetPath);
}

function readFileContent(filePath) {
    return new Promise((resolve) => {
        const fullPath = resolvePath(filePath);
        if (!fullPath) {
            resolve({ success: false, error: 'Path tidak valid' });
            return;
        }
        fs.readFile(fullPath, 'utf8', (err, data) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true, content: data, path: fullPath });
            }
        });
    });
}

function writeFileContent(filePath, content) {
    return new Promise((resolve) => {
        const fullPath = resolvePath(filePath);
        if (!fullPath) {
            resolve({ success: false, error: 'Path tidak valid' });
            return;
        }
        fs.writeFile(fullPath, content, 'utf8', (err) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true, path: fullPath });
            }
        });
    });
}

function createFolder(folderPath) {
    return new Promise((resolve) => {
        const fullPath = resolvePath(folderPath);
        if (!fullPath) {
            resolve({ success: false, error: 'Path tidak valid' });
            return;
        }
        fs.mkdir(fullPath, { recursive: true }, (err) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true, path: fullPath });
            }
        });
    });
}

function deleteFile(filePath) {
    return new Promise((resolve) => {
        const fullPath = resolvePath(filePath);
        if (!fullPath) {
            resolve({ success: false, error: 'Path tidak valid' });
            return;
        }
        if (!fs.existsSync(fullPath)) {
            resolve({ success: false, error: 'File tidak ditemukan' });
            return;
        }
        fs.unlink(fullPath, (err) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true, path: fullPath });
            }
        });
    });
}

function deleteFolder(folderPath) {
    return new Promise((resolve) => {
        const fullPath = resolvePath(folderPath);
        if (!fullPath) {
            resolve({ success: false, error: 'Path tidak valid' });
            return;
        }
        if (!fs.existsSync(fullPath)) {
            resolve({ success: false, error: 'Folder tidak ditemukan' });
            return;
        }
        fs.rm(fullPath, { recursive: true, force: true }, (err) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true, path: fullPath });
            }
        });
    });
}

function renamePath(oldPath, newPath) {
    return new Promise((resolve) => {
        const fullOld = resolvePath(oldPath);
        const fullNew = resolvePath(newPath);
        if (!fullOld || !fullNew) {
            resolve({ success: false, error: 'Path tidak valid' });
            return;
        }
        if (!fs.existsSync(fullOld)) {
            resolve({ success: false, error: 'File/folder tidak ditemukan' });
            return;
        }
        fs.rename(fullOld, fullNew, (err) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true, oldPath: fullOld, newPath: fullNew });
            }
        });
    });
}

function listDirectory(dirPath) {
    return new Promise((resolve) => {
        const fullPath = resolvePath(dirPath || '.');
        if (!fullPath) {
            resolve({ success: false, error: 'Path tidak valid' });
            return;
        }
        fs.readdir(fullPath, { withFileTypes: true }, (err, items) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                const result = items.map(item => ({
                    name: item.name,
                    type: item.isDirectory() ? 'folder' : 'file'
                }));
                resolve({ success: true, path: fullPath, items: result });
            }
        });
    });
}

function executeShutdown() {
    return new Promise((resolve) => {
        let cmd;
        if (osType === 'Windows') {
            cmd = 'shutdown /s /t 60';
        } else if (osType === 'macOS') {
            cmd = 'osascript -e \'tell app "System Events" to shut down\'';
        } else {
            cmd = 'shutdown -h now';
        }
        exec(cmd, (err) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true, action: 'shutdown' });
            }
        });
    });
}

function executeRestart() {
    return new Promise((resolve) => {
        let cmd;
        if (osType === 'Windows') {
            cmd = 'shutdown /r /t 60';
        } else if (osType === 'macOS') {
            cmd = 'osascript -e \'tell app "System Events" to restart\'';
        } else {
            cmd = 'shutdown -r now';
        }
        exec(cmd, (err) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true, action: 'restart' });
            }
        });
    });
}

function cancelShutdown() {
    return new Promise((resolve) => {
        let cmd;
        if (osType === 'Windows') {
            cmd = 'shutdown /a';
        } else if (osType === 'macOS' || osType === 'Linux') {
            cmd = 'killall shutdown 2>/dev/null; shutdown -c 2>/dev/null';
        } else {
            cmd = 'shutdown -c';
        }
        exec(cmd, (err) => {
            resolve({ success: true });
        });
    });
}

function getOpenWindows() {
    return new Promise((resolve) => {
        let cmd;
        if (osType === 'Windows') {
            cmd = 'powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle -ne \\\"\\\"} | ForEach-Object { $_.Id.ToString() + \\\"|\\\" + $_.ProcessName + \\\"|\\\" + $_.MainWindowTitle }"';
        } else if (osType === 'macOS') {
            cmd = 'osascript -e \'tell app "System Events" to get name of every process whose visible is true\'';
        } else {
            cmd = 'wmctrl -l 2>/dev/null || xdotool list-windows 2>/dev/null';
        }
        
        exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
            if (err) {
                resolve({ success: false, error: err.message, windows: [] });
                return;
            }
            
            const windows = [];
            
            if (osType === 'Windows') {
                const lines = stdout.trim().split('\n').filter(line => line.includes('|'));
                lines.forEach(line => {
                    const parts = line.split('|');
                    if (parts.length >= 3) {
                        const pid = parts[0].trim();
                        const processName = parts[1].trim();
                        const title = parts.slice(2).join('|').trim();
                        if (title && pid) {
                            windows.push({
                                pid: pid,
                                name: processName,
                                title: title
                            });
                        }
                    }
                });
            } else if (osType === 'macOS') {
                const apps = stdout.trim().split(',').map(s => s.trim().replace(/"/g, ''));
                apps.forEach((app, idx) => {
                    if (app) {
                        windows.push({
                            pid: idx.toString(),
                            name: app,
                            title: app
                        });
                    }
                });
            } else {
                const lines = stdout.trim().split('\n');
                lines.forEach((line, idx) => {
                    if (line.trim()) {
                        windows.push({
                            pid: idx.toString(),
                            name: line.trim(),
                            title: line.trim()
                        });
                    }
                });
            }
            
            resolve({ success: true, windows: windows });
        });
    });
}

function closeWindow(pid, windowName) {
    return new Promise((resolve) => {
        let cmd;
        
        if (osType === 'Windows') {
            cmd = `taskkill /F /PID ${pid}`;
        } else if (osType === 'macOS') {
            cmd = `osascript -e 'tell app "${windowName}" to quit'`;
        } else {
            cmd = `kill -9 ${pid} 2>/dev/null || xdotool windowclose ${pid}`;
        }
        
        exec(cmd, { timeout: 5000 }, (err, stdout, stderr) => {
            if (err) {
                if (osType === 'Windows' && err.message.includes('Access is denied')) {
                    resolve({ success: false, error: 'Tidak dapat menutup sistem process. Coba tutup secara manual.' });
                } else {
                    resolve({ success: false, error: err.message });
                }
            } else {
                resolve({ success: true });
            }
        });
    });
}

function closeTabByName(tabName) {
    return new Promise((resolve) => {
        let cmd;
        
        if (osType === 'Windows') {
            cmd = `powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle -like '*${tabName}*' -or $_.ProcessName -like '*${tabName}*'} | Stop-Process -Force"`;
        } else if (osType === 'macOS') {
            cmd = `osascript -e 'tell app "${tabName}" to quit'`;
        } else {
            cmd = `pkill -f "${tabName}"`;
        }
        
        exec(cmd, { timeout: 5000 }, (err, stdout, stderr) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true });
            }
        });
    });
}

function typeInVSCode(content, fileType) {
    return new Promise((resolve) => {
        if (osType !== 'Windows') {
            resolve({ success: false, error: 'Typing effect hanya tersedia di Windows' });
            return;
        }

        const lines = content.split('\n');
        const scriptLines = [];
        scriptLines.push('Add-Type -AssemblyName System.Windows.Forms');
        scriptLines.push('Start-Sleep -Seconds 2');
        
        lines.forEach((line, idx) => {
            const escapedLine = line.replace(/'/g, "''").replace(/"/g, '`"');
            if (idx === 0) {
                scriptLines.push(`[System.Windows.Forms.SendKeys]::SendWait("${escapedLine}")`);
            } else {
                scriptLines.push('[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")');
                if (line.length > 0) {
                    scriptLines.push(`[System.Windows.Forms.SendKeys]::SendWait("${escapedLine}")`);
                }
            }
            scriptLines.push('Start-Sleep -Milliseconds 20');
        });

        const psScript = scriptLines.join('; ');
        const encodedScript = Buffer.from(psScript).toString('base64');
        const cmd = 'powershell -WindowStyle Hidden -EncodedCommand ' + encodedScript;
        
        exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
            if (err) {
                console.error('[OMIRA] Typing error:', err.message);
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true });
            }
        });
    });
}

function openVSCodeWithFile(filePath) {
    return new Promise((resolve) => {
        const cmd = `code "${filePath}"`;
        exec(cmd, { shell: 'cmd.exe' }, (err) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true, path: filePath });
            }
        });
    });
}

async function generateCode(projectName, description, fileTypes) {
    const fileTypeMap = {
        'html': 'index.html',
        'css': 'style.css',
        'js': 'script.js',
        'javascript': 'script.js'
    };

    const systemPrompt = `Kamu adalah web developer expert. Buat kode lengkap untuk project: "${description}"

IMPORTANT:
- Buatkan kode yang BENAR dan LENGKAP
- HTML harus valid dengan doctype, html, head, body yang tepat
- CSS harus modern dan responsif
- JS harus clean dan functional
- Kode harus bisa langsung jalan tanpa error

BALAS HANYA DENGAN JSON FORMAT:
{
  "files": {
    "nama_file.html": "isi kode HTML lengkap",
    "style.css": "isi kode CSS lengkap",
    "script.js": "isi kode JS lengkap (kosongkan kalau tidak perlu)"
  }
}

Contoh structure:
- index.html: HTML structure dengan embedded CSS atau link ke style.css
- style.css: Semua styling
`;

    try {
        const response = await openai.chat.completions.create({
            model: AI_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Buatkan saya ${description} dengan format: ${fileTypes.join(', ')}` }
            ],
            temperature: 0.3,
            max_tokens: 8000
        });

        let result = response.choices[0].message.content.trim();
        
        if (result.startsWith('```json')) {
            result = result.replace(/```json\n?|```\n?/g, '').trim();
        }
        
        const codeData = JSON.parse(result);
        return { success: true, files: codeData.files };
    } catch (error) {
        console.error('[OMIRA] Code generation error:', error.message);
        return { success: false, error: error.message };
    }
}

async function createCodeProject(chatId, projectName, description, fileTypes) {
    const projectDir = path.join(WORKING_DIR, projectName);
    
    if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
    }
    
    await bot.sendMessage(chatId, `🎨 *Generating code...*\n\n📝 Project: *${escapeMarkdown(projectName)}*\n📁 Files: ${fileTypes.join(', ')}`, { parse_mode: 'Markdown' });
    
    const generated = await generateCode(projectName, description, fileTypes);
    
    if (!generated.success) {
        return { success: false, error: generated.error };
    }
    
    const fileList = [];
    for (const [filename, content] of Object.entries(generated.files)) {
        const filePath = path.join(projectDir, filename);
        fs.writeFileSync(filePath, content, 'utf8');
        fileList.push({ name: filename, path: filePath });
        await bot.sendMessage(chatId, `✅ File created: *${escapeMarkdown(filename)}*`, { parse_mode: 'Markdown' });
    }
    
    return { success: true, projectDir, files: fileList };
}

async function createCodeProject(chatId, projectName, description, fileTypes) {
    const projectDir = path.join(WORKING_DIR, projectName);
    
    if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
    }
    
    await bot.sendMessage(chatId, `🎨 *Generating code...*\n\n📝 Project: *${escapeMarkdown(projectName)}*\n📁 Files: ${fileTypes.join(', ')}`, { parse_mode: 'Markdown' });
    
    const generated = await generateCode(projectName, description, fileTypes);
    
    if (!generated.success) {
        return { success: false, error: generated.error };
    }
    
    const fileList = [];
    for (const [filename, content] of Object.entries(generated.files)) {
        const filePath = path.join(projectDir, filename);
        fs.writeFileSync(filePath, content, 'utf8');
        fileList.push({ name: filename, path: filePath });
        await bot.sendMessage(chatId, `✅ File created: *${escapeMarkdown(filename)}*`, { parse_mode: 'Markdown' });
    }
    
    return { success: true, projectDir, files: fileList };
}

function getShellCommand(os) {
    if (os === 'Windows') return 'powershell';
    return 'bash';
}

function isURL(str) {
    try {
        new URL(str);
        return true;
    } catch {
        return false;
    }
}

async function getAppLaunchCommand(appName, targetOS) {
    if (isURL(appName)) {
        const command = targetOS === 'Windows' ? `start "" "${appName}"` : `open "${appName}"`;
        return { success: true, command: command, shell: getShellCommand(targetOS), isUrl: true };
    }

    if (!appName.startsWith('http') && !appName.includes('.') && !appName.includes('www.')) {
        const command = targetOS === 'Windows' ? `start "" "${appName}"` : `open "${appName}"`;
        return { success: true, command: command, shell: getShellCommand(targetOS) };
    }

    let shellType = getShellCommand(targetOS);
    
    const prompt = `User ingin membuka "${appName}" di sistem operasi ${targetOS}.

Beri saya perintah ${shellType === 'powershell' ? 'POWERSHELL' : 'TERMINAL/BASH'} yang TEPAT dan BENAR untuk membuka ini.

BALAS HANYA DENGAN JSON, TANPA PENJELASAN:
{"command": "perintah yang akan membuka ini di ${targetOS}"}

Contoh untuk ${targetOS}:
${targetOS === 'Windows' ? `
- VS Code: {"command": "code"}
- Chrome: {"command": "start chrome"}
- Notepad: {"command": "notepad"}
- google.com: {"command": "start chrome google.com"}
` : targetOS === 'macOS' ? `
- VS Code: {"command": "open -a 'Visual Studio Code'"}
- Chrome: {"command": "open -a 'Google Chrome'"}
- google.com: {"command": "open http://google.com"}
` : `
- VS Code: {"command": "code"}
- Chrome: {"command": "google-chrome"}
- google.com: {"command": "google-chrome google.com"}
`}

Pastikan command 100% benar untuk ${targetOS}!`;

    try {
        const response = await openai.chat.completions.create({
            model: AI_MODEL,
            messages: [
                { role: 'system', content: `Kamu AI expert ${targetOS}. Berikan perintah ${shellType === 'powershell' ? 'PowerShell' : 'terminal/bash'} yang tepat.` },
                { role: 'user', content: prompt }
            ],
            temperature: 0.1,
            max_tokens: 256
        });

        let result = response.choices[0].message.content.trim();
        
        if (result.startsWith('```json')) {
            result = result.replace(/```json\n?|```\n?/g, '').trim();
        }
        
        try {
            const cmdObj = JSON.parse(result);
            return { success: true, command: cmdObj.command, shell: shellType };
        } catch (parseError) {
            const fallback = targetOS === 'Windows' ? `start "" "${appName}"` : `open "${appName}"`;
            return { success: true, command: fallback, shell: shellType };
        }
    } catch (error) {
        console.error('Error getting launch command:', error.message);
        const fallback = targetOS === 'Windows' ? `start "" "${appName}"` : `open "${appName}"`;
        return { success: true, command: fallback, shell: shellType };
    }
}

function openApplicationDynamic(command, shellType) {
    return new Promise((resolve) => {
        console.log(`[OMIRA] Executing (${shellType}): ${command}`);
        
        let finalCommand = command;
        const options = {};
        
        if (shellType === 'powershell') {
            options.shell = 'powershell.exe';
            const urlMatch = command.match(/start\s+""\s+"([^"]+)"/i);
            if (urlMatch) {
                const url = urlMatch[1];
                finalCommand = `Start-Process -FilePath "${url}"`;
            }
        } else {
            options.shell = '/bin/bash';
        }
        
        exec(finalCommand, options, (err, stdout, stderr) => {
            if (err) {
                console.error(`[OMIRA] Error: ${err.message}`);
                resolve({ success: false, error: err.message });
            } else {
                console.log(`[OMIRA] Success`);
                resolve({ success: true, command: finalCommand });
            }
        });
    });
}

function openApplication(appName) {
    return new Promise((resolve) => {
        let cmd, shell;
        if (osType === 'Windows') {
            cmd = `start "" "${appName}"`;
            shell = 'powershell';
        } else if (osType === 'macOS') {
            cmd = `open -a "${appName}"`;
            shell = 'bash';
        } else {
            cmd = appName;
            shell = 'bash';
        }
        exec(cmd, { shell }, (err) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true, app: appName });
            }
        });
    });
}

async function processAICommand(chatId, userMessage) {
    const memory = await loadMemory();
    const memoryContext = memoryToText(memory);
    
    const systemPrompt = `Kamu adalah OMIRA, AI Assistant yang berjalan di ${osType}.

KAMU PUNYA CAPABLE UNTUK MENGELOLA FILE SYSTEM. Kamu harus langsung action, bukan cuma kasih tau.

WORKING DIRECTORY: ${WORKING_DIR}

=== MEMORY (INFO USER) ===
${memoryContext || 'Belum ada informasi tentang user.'}
=== END MEMORY ===

FORMAT RESPON (WAJIB IKUTI):
1. Jika user mau baca file, lihat isi folder, atau info umum -> Jawab langsung dalam bahasa Indonesia, singkat dan jelas.
2. Jika user mau operasi file (buat, edit, hapus, rename) -> Kembalikan JSON dengan format:

Untuk READ file:
{"action": "read_file", "path": "nama_file.txt"}

Untuk LIST folder:
{"action": "list_dir", "path": "."}  atau {"action": "list_dir", "path": "nama_folder"}

Untuk CREATE folder:
{"action": "create_folder", "path": "nama_folder_baru"}

Untuk CREATE file:
{"action": "create_file", "path": "nama_file.txt", "content": "isi file"}

Untuk EDIT file (REPLACE SEMUA ISI):
{"action": "edit_file", "path": "nama_file.txt", "content": "isi baru", "need_confirm": true, "old_preview": "preview isi lama max 200 char", "new_preview": "preview isi baru max 200 char"}

Untuk DELETE file:
{"action": "delete_file", "path": "nama_file.txt", "need_confirm": true}

Untuk DELETE folder:
{"action": "delete_folder", "path": "nama_folder", "need_confirm": true}

Untuk RENAME file/folder:
{"action": "rename", "old_path": "nama_lama.txt", "new_path": "nama_baru.txt"}

Untuk BUKA aplikasi:
{"action": "open_app", "app": "nama_aplikasi"}

Untuk BUKA aplikasi DENGAN CARA SMART (AI akan cari command yang tepat):
{"action": "open_app_smart", "app": "nama_aplikasi"}

Untuk MATIKAN laptop:
{"action": "shutdown", "need_confirm": true}

Untuk RESTART laptop:
{"action": "restart", "need_confirm": true}

Untuk CANCEL shutdown/restart:
{"action": "cancel_shutdown"}

Untuk LIHAT TAB yang terbuka:
{"action": "list_tabs"}

Untuk TUTUP TAB (berdasarkan nama):
{"action": "close_tab", "name": "nama_aplikasi"}

Untuk CODING - BUAT PROJECT CODE:
{"action": "code_project", "project_name": "nama_project", "description": "deskripsi project", "file_types": ["html", "css", "js"]}

Untuk BUKA FILE DI VSCODE:
{"action": "open_vscode", "file_path": "path/ke/file.html"}

Untuk TYPING EFFECT di VSCODE:
{"action": "type_effect", "file_path": "path/ke/file.html", "content": "isi kode yang akan diketik"}

Untuk SIMPAN INFO USER ke memory.json:
{"action": "save_memory", "updates": {"user_info": {"name": "nama", "nickname": "panggilan"}, "facts": ["fakta1", "fakta2"], "preferences": {"key": "value"}}}

Untuk BUKA VIDEO YOUTUBE (jika pesan user mengandung link youtube, WAJIB extract linknya):
Contoh user: "buka https://youtu.be/abc123"
Contoh user: "tonton video ini https://www.youtube.com/watch?v=xyz789"
Contoh user: "buka youtube.com/watch?v=aaa111"

WAJIB extract URL youtube dari pesan, lalu:
{"action": "play_youtube", "url": "https://youtu.be/abc123"}

Untuk CHATBIASA (tidak perlu aksi):
{"action": "chat", "message": "respon kamu di sini"}

PERATURAN PENTING:
- need_confirm: true untuk operasi BERBAHAYA (delete, shutdown, restart, edit_file)
- Path relatif akan resolve ke ${WORKING_DIR}
- Preview max 200 karakter untuk konfirmasi
- Jawab DALAM BAHASA INDONESIA untuk chat biasa
- JANGTidak kasih response yang tidak sesuai format JSON di atas!
- Untuk BUKA APLIKASI, SELALU gunakan open_app_smart!
- Jika user menyebutkan nama, pekerjaan, fakta tentang diri mereka, SELALU gunakan save_memory untuk menyimpan!
- GUNAKAN NAMA/PANGGILAN USER dari memory saat berbicara dengan mereka!
- JIKA PESAN USER MENGANDUNG LINK YOUTUBE (youtu.be, youtube.com/watch, youtube.com/shorts, dll), SELALU gunakan play_youtube dengan URL yang sudah di-extract!
`;

        try {
        const chatCompletion = await openai.chat.completions.create({
            model: AI_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            temperature: 0.3,
            max_tokens: 1024
        });

        let aiResponse = chatCompletion.choices[0].message.content.trim();
        
        if (aiResponse.startsWith('```json')) {
            aiResponse = aiResponse.replace(/```json\n?|```\n?/g, '').trim();
        } else if (aiResponse.startsWith('```')) {
            aiResponse = aiResponse.replace(/```\n?/g, '').trim();
        }

        let command;
        try {
            command = JSON.parse(aiResponse);
        } catch (e) {
            return { action: 'chat', message: aiResponse };
        }

        switch (command.action) {
            case 'read_file': {
                const result = await readFileContent(command.path);
                if (result.success) {
                    const preview = result.content.length > 1000 
                        ? result.content.substring(0, 1000) + '\n\n... (file terlalu panjang, potong 1000 char pertama)' 
                        : result.content;
                    return { 
                        action: 'result', 
                        message: `📄 *File: ${escapeMarkdown(command.path)}*\n\n\`\`\`\n${preview}\n\`\`\``

                    };
                } else {
                    return { action: 'result', message: `❌ Gagal membaca file: ${result.error}` };
                }
            }

            case 'list_dir': {
                const result = await listDirectory(command.path);
                if (result.success) {
                    let msg = `📁 *Isi folder: ${escapeMarkdown(result.path)}*\n\n`;
                    result.items.forEach(item => {
                        const icon = item.type === 'folder' ? '📁' : '📄';
                        msg += `${icon} ${item.name}\n`;
                    });
                    return { action: 'result', message: msg, parseMode: 'Markdown' };
                } else {
                    return { action: 'result', message: `❌ Gagal membaca folder: ${result.error}` };
                }
            }

            case 'create_folder': {
                const result = await createFolder(command.path);
                if (result.success) {
                    return { action: 'result', message: `✅ Folder berhasil dibuat: ${escapeMarkdown(result.path)}` };
                } else {
                    return { action: 'result', message: `❌ Gagal membuat folder: ${result.error}` };
                }
            }

            case 'create_file': {
                const result = await writeFileContent(command.path, command.content);
                if (result.success) {
                    return { action: 'result', message: `✅ File berhasil dibuat: ${escapeMarkdown(result.path)}` };
                } else {
                    return { action: 'result', message: `❌ Gagal membuat file: ${result.error}` };
                }
            }

            case 'edit_file': {
                if (command.need_confirm) {
                    userState[chatId] = {
                        action: 'edit_file',
                        path: command.path,
                        content: command.content,
                        oldPreview: command.old_preview || '',
                        newPreview: command.new_preview || ''
                    };
                    return {
                        action: 'confirm_edit',
                        path: command.path,
                        oldPreview: command.old_preview || '',
                        newPreview: command.new_preview || ''
                    };
                } else {
                    const result = await writeFileContent(command.path, command.content);
                    if (result.success) {
                        return { action: 'result', message: `✅ File berhasil diedit: ${escapeMarkdown(result.path)}` };
                    } else {
                        return { action: 'result', message: `❌ Gagal mengedit file: ${result.error}` };
                    }
                }
            }

            case 'delete_file': {
                if (command.need_confirm) {
                    userState[chatId] = {
                        action: 'delete_file',
                        path: command.path
                    };
                    return {
                        action: 'confirm_delete_file',
                        path: command.path
                    };
                } else {
                    const result = await deleteFile(command.path);
                    if (result.success) {
                        return { action: 'result', message: `✅ File berhasil dihapus: ${escapeMarkdown(result.path)}` };
                    } else {
                        return { action: 'result', message: `❌ Gagal menghapus file: ${result.error}` };
                    }
                }
            }

            case 'delete_folder': {
                if (command.need_confirm) {
                    userState[chatId] = {
                        action: 'delete_folder',
                        path: command.path
                    };
                    return {
                        action: 'confirm_delete_folder',
                        path: command.path
                    };
                } else {
                    const result = await deleteFolder(command.path);
                    if (result.success) {
                        return { action: 'result', message: `✅ Folder berhasil dihapus: ${escapeMarkdown(result.path)}` };
                    } else {
                        return { action: 'result', message: `❌ Gagal menghapus folder: ${result.error}` };
                    }
                }
            }

            case 'rename': {
                const result = await renamePath(command.old_path, command.new_path);
                if (result.success) {
                    return { action: 'result', message: `✅ Berhasil rename: ${escapeMarkdown(result.oldPath)} → ${escapeMarkdown(result.newPath)}` };
                } else {
                    return { action: 'result', message: `❌ Gagal rename: ${result.error}` };
                }
            }

            case 'open_app': {
                await bot.sendMessage(chatId, `🔍 Mencari cara membuka "${command.app}" di ${osType}...`);
                
                const launchCmd = await getAppLaunchCommand(command.app, osType);
                
                if (!launchCmd.success || !launchCmd.command) {
                    const fallback = await openApplication(command.app);
                    if (fallback.success) {
                        return { action: 'result', message: `✅ Berhasil membuka: ${fallback.app}` };
                    } else {
                        return { action: 'result', message: `❌ Gagal membuka "${command.app}": ${launchCmd.error || fallback.error}` };
                    }
                }
                
                await bot.sendMessage(chatId, `⚡ Executing (${launchCmd.shell}): ${launchCmd.command}`);
                
                const result = await openApplicationDynamic(launchCmd.command, launchCmd.shell);
                if (result.success) {
                    return { action: 'result', message: `✅ Berhasil membuka: ${command.app}\n📋 Command: ${launchCmd.command}` };
                } else {
                    return { action: 'result', message: `❌ Gagal membuka "${command.app}": ${result.error}` };
                }
            }

            case 'open_app_smart': {
                await bot.sendMessage(chatId, `🔍 Mencari cara membuka "${command.app}" di ${osType}...`);
                
                const launchCmd = await getAppLaunchCommand(command.app, osType);
                
                if (!launchCmd.success || !launchCmd.command) {
                    const fallback = await openApplication(command.app);
                    if (fallback.success) {
                        return { action: 'result', message: `✅ Berhasil membuka: ${fallback.app}` };
                    } else {
                        return { action: 'result', message: `❌ Gagal membuka "${command.app}": ${launchCmd.error || fallback.error}` };
                    }
                }
                
                await bot.sendMessage(chatId, `⚡ Executing (${launchCmd.shell}): ${launchCmd.command}`);
                
                const result = await openApplicationDynamic(launchCmd.command, launchCmd.shell);
                if (result.success) {
                    return { action: 'result', message: `✅ Berhasil membuka: ${command.app}\n📋 Command: ${launchCmd.command}` };
                } else {
                    return { action: 'result', message: `❌ Gagal membuka "${command.app}": ${result.error}` };
                }
            }

            case 'shutdown': {
                if (command.need_confirm) {
                    userState[chatId] = { action: 'shutdown' };
                    return { action: 'confirm_shutdown' };
                } else {
                    const result = await executeShutdown();
                    if (result.success) {
                        return { action: 'result', message: `⚠️ Laptop akan dimatikan dalam 60 detik...\n\nKetik "batal" untuk membatalkan.` };
                    } else {
                        return { action: 'result', message: `❌ Gagal: ${result.error}` };
                    }
                }
            }

            case 'play_youtube': {
                const url = command.url;
                
                if (!url || !isYouTubeUrl(url)) {
                    const extractedUrl = extractYouTubeUrlFromText(url || command.url);
                    if (extractedUrl) {
                        url = extractedUrl;
                    } else {
                        return { action: 'result', message: `❌ URL YouTube tidak valid.` };
                    }
                }
                
                const videoInfo = await getYouTubeVideoInfo(url);
                
                if (!videoInfo.success) {
                    return { action: 'result', message: `❌ Gagal mengambil info video: ${videoInfo.error}` };
                }
                
                const info = videoInfo.info;
                const desc = info.description.length > 200 
                    ? info.description.substring(0, 200) + '...' 
                    : info.description;
                
                activeVideos[`${chatId}_${info.videoId}`] = info;
                
                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: '▶️ PLAY', callback_data: `yt_play_${info.videoId}` },
                            { text: '⏹️ STOP', callback_data: `yt_stop_${info.videoId}` }
                        ],
                        [
                            { text: '⏭️ GO TO', callback_data: `yt_goto_${info.videoId}` }
                        ]
                    ]
                };
                
                const messageText = `▶️ *Video: ${escapeMarkdown(info.title)}*\n\n📝 *Deskripsi:*\n${escapeMarkdown(desc)}\n\n🎮 *Control Panel:*`;
                
                return { 
                    action: 'youtube_player', 
                    message: messageText,
                    parseMode: 'Markdown',
                    replyMarkup: keyboard
                };
            }

            case 'restart': {
                if (command.need_confirm) {
                    userState[chatId] = { action: 'restart' };
                    return { action: 'confirm_restart' };
                } else {
                    const result = await executeRestart();
                    if (result.success) {
                        return { action: 'result', message: `⚠️ Laptop akan direstart dalam 60 detik...\n\nKetik "batal" untuk membatalkan.` };
                    } else {
                        return { action: 'result', message: `❌ Gagal: ${result.error}` };
                    }
                }
            }

            case 'cancel_shutdown': {
                await cancelShutdown();
                return { action: 'result', message: `✅ Pembatalan berhasil!` };
            }

            case 'list_tabs': {
                const windowResult = await getOpenWindows();
                if (!windowResult.success) {
                    return { action: 'result', message: `❌ Gagal mengambil daftar tab: ${windowResult.error}` };
                }
                
                if (windowResult.windows.length === 0) {
                    return { action: 'result', message: `📭 Tidak ada tab/jendela yang ditemukan.` };
                }
                
                const uniqueWindows = [];
                const seen = new Set();
                windowResult.windows.forEach(w => {
                    const key = w.name.toLowerCase();
                    if (!seen.has(key)) {
                        seen.add(key);
                        uniqueWindows.push(w);
                    }
                });
                
                return { action: 'list_tabs', windows: uniqueWindows };
            }

            case 'close_tab': {
                if (!command.name) {
                    return { action: 'result', message: `❌ Nama tab tidak disebutkan.` };
                }
                
                await bot.sendMessage(chatId, `🔍 Mencari tab "${command.name}"...`);
                
                const closeResult = await closeTabByName(command.name);
                
                if (closeResult.success) {
                    return { action: 'result', message: `✅ Tab "${command.name}" berhasil ditutup!` };
                } else {
                    return { action: 'result', message: `❌ Gagal menutup tab "${command.name}": ${closeResult.error}` };
                }
            }

            case 'close_tab_by_pid': {
                if (!command.pid || !command.name) {
                    return { action: 'result', message: `❌ Data tab tidak valid.` };
                }
                
                await bot.sendMessage(chatId, `⏳ Menutup "${command.name}"...`);
                
                const closeResult = await closeWindow(command.pid, command.name);
                
                if (closeResult.success) {
                    return { action: 'result', message: `✅ "${command.name}" berhasil ditutup!` };
                } else {
                    return { action: 'result', message: `❌ Gagal menutup "${command.name}": ${closeResult.error}` };
                }
            }

            case 'code_project': {
                if (!command.project_name || !command.description || !command.file_types) {
                    return { action: 'result', message: `❌ Data project tidak lengkap. Perlu: project_name, description, file_types` };
                }
                
                const projectName = command.project_name.replace(/[^a-zA-Z0-9_-]/g, '_');
                const projectResult = await createCodeProject(chatId, projectName, command.description, command.file_types);
                
                if (!projectResult.success) {
                    return { action: 'result', message: `❌ Gagal membuat project: ${projectResult.error}` };
                }
                
                return { 
                    action: 'code_project_done', 
                    projectDir: projectResult.projectDir,
                    files: projectResult.files,
                    projectName: projectName
                };
            }

            case 'open_vscode': {
                if (!command.file_path) {
                    return { action: 'result', message: `❌ Path file tidak disebutkan.` };
                }
                
                const fullPath = resolvePath(command.file_path);
                const openResult = await openVSCodeWithFile(fullPath);
                
                if (openResult.success) {
                    return { action: 'result', message: `✅ VSCode terbuka!\n📄 File: ${fullPath}` };
                } else {
                    return { action: 'result', message: `❌ Gagal membuka VSCode: ${openResult.error}` };
                }
            }

            case 'type_effect': {
                if (!command.file_path || !command.content) {
                    return { action: 'result', message: `❌ Data tidak lengkap.` };
                }
                
                const fullPath = resolvePath(command.file_path);
                await openVSCodeWithFile(fullPath);
                
                return { 
                    action: 'typing_effect', 
                    filePath: fullPath,
                    content: command.content
                };
            }

            case 'save_memory': {
                if (command.updates) {
                    const currentMemory = await loadMemory();
                    
                    if (command.updates.user_info) {
                        currentMemory.user_info = { ...currentMemory.user_info, ...command.updates.user_info };
                    }
                    if (command.updates.facts) {
                        command.updates.facts.forEach(fact => {
                            if (!currentMemory.facts.includes(fact)) {
                                currentMemory.facts.push(fact);
                            }
                        });
                    }
                    if (command.updates.preferences) {
                        currentMemory.preferences = { ...currentMemory.preferences, ...command.updates.preferences };
                    }
                    
                    await saveMemory(currentMemory);
                    console.log(`[OMIRA] Memory updated:`, currentMemory);
                }
                return { action: 'result', message: `✅ Info berhasil disimpan ke memory!` };
            }

            case 'chat':
            default:
                return { action: 'chat', message: command.message || aiResponse };
        }
    } catch (error) {
        console.error('Error AI:', error.message);
        return { action: 'result', message: `❌ Error: ${error.message}` };
    }
}

async function sendResponse(chatId, response) {
    if (response.action === 'confirm_edit') {
        const message = `
📝 *KONFIRMASI EDIT FILE*

📄 File: ${escapeMarkdown(response.path)}

*Sebelum diubah:*
\`\`\`
${response.oldPreview}
\`\`\`

*Setelah diubah:*
\`\`\`
${response.newPreview}
\`\`\`

⚠️ Apakah Anda yakin ingin mengubah file ini?`;

        await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ YA', callback_data: 'confirm_yes' },
                        { text: '❌ TIDAK', callback_data: 'confirm_no' }
                    ]
                ]
            }
        });
    } else if (response.action === 'confirm_delete_file') {
        await bot.sendMessage(chatId, `⚠️ *PERINGATAN*\n\nYakin ingin menghapus file: ${escapeMarkdown(response.path)}?\n\nTindakan ini tidak dapat dibatalkan!`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ YA', callback_data: 'confirm_yes' },
                        { text: '❌ TIDAK', callback_data: 'confirm_no' }
                    ]
                ]
            }
        });
    } else if (response.action === 'confirm_delete_folder') {
        await bot.sendMessage(chatId, `⚠️ *PERINGATAN*\n\nYakin ingin menghapus folder: ${escapeMarkdown(response.path)}?\n\nTindakan ini tidak dapat dibatalkan!`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ YA', callback_data: 'confirm_yes' },
                        { text: '❌ TIDAK', callback_data: 'confirm_no' }
                    ]
                ]
            }
        });
    } else if (response.action === 'confirm_shutdown') {
        await bot.sendMessage(chatId, `⚠️ *PERINGATAN*\n\nYakin ingin **mematikan laptop**?\n\nTindakan ini tidak dapat dibatalkan!`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ YA', callback_data: 'confirm_yes' },
                        { text: '❌ TIDAK', callback_data: 'confirm_no' }
                    ]
                ]
            }
        });
    } else if (response.action === 'confirm_restart') {
        await bot.sendMessage(chatId, `⚠️ *PERINGATAN*\n\nYakin ingin **merestart laptop**?\n\nTindakan ini tidak dapat dibatalkan!`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ YA', callback_data: 'confirm_yes' },
                        { text: '❌ TIDAK', callback_data: 'confirm_no' }
                    ]
                ]
            }
        });
    } else if (response.action === 'youtube_player') {
        await bot.sendMessage(chatId, response.message, {
            parse_mode: response.parseMode,
            reply_markup: {
                inline_keyboard: response.replyMarkup.inline_keyboard
            }
        });
    } else if (response.action === 'list_tabs') {
        const windows = response.windows;
        let message = `📋 *TAB/JENDELA YANG TERBUKA*\n\n`;
        message += `Klik tombol di bawah untuk menutup:\n\n`;
        
        const keyboard = [];
        windows.forEach((w, idx) => {
            const displayName = w.title.length > 40 ? w.title.substring(0, 40) + '...' : w.title;
            keyboard.push([{ text: `❌ ${displayName}`, callback_data: `close_${w.pid}_${encodeURIComponent(w.name)}` }]);
        });
        keyboard.push([{ text: '🔄 Refresh', callback_data: 'refresh_tabs' }]);
        
        await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
    } else if (response.action === 'code_project_done') {
        let message = `🎉 *PROJECT BERHASIL DIBUAT!*\n\n`;
        message += `📁 Project: *${response.projectName}*\n`;
        message += `📂 Lokasi: ${response.projectDir}\n\n`;
        message += `📄 Files:\n`;
        response.files.forEach(f => {
            message += `• ${f.name}\n`;
        });
        message += `\nKlik tombol di bawah untuk membuka di VSCode:`;
        
        const keyboard = response.files.map(f => {
            return [{ text: `📝 ${f.name}`, callback_data: `openfile_${encodeURIComponent(f.path)}` }];
        });
        keyboard.push([{ text: `🚀 Buka semua di VSCode`, callback_data: `openfolder_${encodeURIComponent(response.projectDir)}` }]);
        
        await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
    } else if (response.action === 'typing_effect') {
        await bot.sendMessage(chatId, `⌨️ *TYPING EFFECT AKTIF!*\n\n⏳ Sedang mengetik kode di VSCode...\n📄 File: ${escapeMarkdown(response.filePath)}\n\n⏱️ Tunggu sebentar ya...`, { parse_mode: 'Markdown' });
        
        typeInVSCode(response.content, 'code').then(result => {
            if (!result.success) {
                bot.sendMessage(chatId, `⚠️ Typing effect gagal, tapi file sudah dibuat.`, { parse_mode: 'Markdown' }).catch(() => {});
            }
        });
    } else if (response.action === 'result') {
        const parseMode = response.parseMode || 'Markdown';
        const message = parseMode === 'Markdown' ? escapeMarkdown(response.message) : response.message;
        await bot.sendMessage(chatId, message, { parse_mode: parseMode });
    } else if (response.action === 'chat') {
        await bot.sendMessage(chatId, escapeMarkdown(response.message), { parse_mode: 'Markdown' });
    }
}

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAllowedUser(chatId)) {
        bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses.');
        return;
    }
    
    const welcomeMessage = `
🤖 *Omira AI Agent*

Halo! Saya Omira, AI Assistant Anda.

Saya berjalan di sistem: *${osType}*
Working Directory: *${WORKING_DIR}*
AI Model: *${AI_MODEL}*

    Saya bisa bantu Anda untuk:
📁 Membuat/menghapus folder
📄 Membaca/mengedit/menghapus file
🔄 Rename file/folder
💻 Membuka/menutup aplikasi
📋 Melihat dan menutup tab/jendela
🎨 Bikin website/code dengan AI
⚡ Mematikan/menyalakan ulang laptop

Contoh perintah:
• "buka chrome"
• "tutup tab"
• "buatkan website portofolio html css js"
• "matikan laptop"

Cukup tanya atau suruh saya melakukan sesuatu!
    `;
    bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (!isAllowedUser(chatId)) return;
    if (!text || text.startsWith('/')) return;

    if (text.toLowerCase() === 'batal') {
        await cancelShutdown();
        userState[chatId] = null;
        await bot.sendMessage(chatId, '✅ Aksi dibatalkan.');
        return;
    }

    if (userState[chatId] && userState[chatId].pendingConfirm) {
        const answer = text.trim().toUpperCase();
        const state = userState[chatId];
        
        if (answer === 'YA' || answer === 'YES' || answer === 'Y') {
            let result;
            if (state.action === 'edit_file') {
                result = await writeFileContent(state.path, state.content);
                if (result.success) {
                    await bot.sendMessage(chatId, `✅ File berhasil diedit: ${escapeMarkdown(result.path)}``, { parse_mode: 'Markdown' });
                } else {
                    await bot.sendMessage(chatId, `❌ Gagal: ${result.error}`, { parse_mode: 'Markdown' });
                }
            } else if (state.action === 'delete_file') {
                result = await deleteFile(state.path);
                if (result.success) {
                    await bot.sendMessage(chatId, `✅ File berhasil dihapus: ${escapeMarkdown(result.path)}``, { parse_mode: 'Markdown' });
                } else {
                    await bot.sendMessage(chatId, `❌ Gagal: ${result.error}`, { parse_mode: 'Markdown' });
                }
            } else if (state.action === 'delete_folder') {
                result = await deleteFolder(state.path);
                if (result.success) {
                    await bot.sendMessage(chatId, `✅ Folder berhasil dihapus: ${escapeMarkdown(result.path)}``, { parse_mode: 'Markdown' });
                } else {
                    await bot.sendMessage(chatId, `❌ Gagal: ${result.error}`, { parse_mode: 'Markdown' });
                }
            } else if (state.action === 'shutdown') {
                result = await executeShutdown();
                if (result.success) {
                    await bot.sendMessage(chatId, `⚠️ Laptop akan dimatikan dalam 60 detik...\n\nKetik "batal" untuk membatalkan.`);
                }
            } else if (state.action === 'restart') {
                result = await executeRestart();
                if (result.success) {
                    await bot.sendMessage(chatId, `⚠️ Laptop akan direstart dalam 60 detik...\n\nKetik "batal" untuk membatalkan.`);
                }
            }
        } else if (answer === 'TIDAK' || answer === 'NO' || answer === 'N') {
            await bot.sendMessage(chatId, '❌ Dibatalkan.');
        } else {
            await bot.sendMessage(chatId, 'Ketik "YA" atau "TIDAK".');
            return;
        }
        
        userState[chatId] = null;
        return;
    }

    if (containsYouTubeUrl(text)) {
        const youtubeUrl = extractYouTubeUrlFromText(text);
        
        if (youtubeUrl) {
            await bot.sendMessage(chatId, '🎬 Mendeteksi video YouTube! Mengambil info video...');
            
            const videoInfo = await getYouTubeVideoInfo(youtubeUrl);
            
            if (!videoInfo.success) {
                await bot.sendMessage(chatId, `❌ Gagal mengambil info video: ${videoInfo.error}`);
                return;
            }
            
            const info = videoInfo.info;
            const desc = info.description.length > 200 
                ? info.description.substring(0, 200) + '...' 
                : info.description;
            
            activeVideos[${chatId}_${info.videoId}`] = info;
            
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '▶️ PLAY', callback_data: `yt_play_${info.videoId} },
                        { text: '⏹️ STOP', callback_data: `yt_stop_${info.videoId} }
                    ],
                    [
                        { text: '⏭️ GO TO', callback_data: `yt_goto_${info.videoId} }
                    ]
                ]
            };
            
            await bot.sendMessage(chatId, `▶️ *Video: ${escapeMarkdown(info.title)}*\n\n📝 *Deskripsi:*\n${escapeMarkdown(desc)}\n\n🎮 *Control Panel:*`, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            return;
        }
    }

    await bot.sendMessage(chatId, '🤔 Omira sedang memproses...');
    const response = await processAICommand(chatId, text);
    
    if (response.action === 'confirm_edit' || response.action === 'confirm_delete_file' || 
        response.action === 'confirm_delete_folder' || response.action === 'confirm_shutdown' || 
        response.action === 'confirm_restart') {
        userState[chatId] = { ...userState[chatId], pendingConfirm: true };
    }
    
    await sendResponse(chatId, response);
});

bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;
    
    if (!isAllowedUser(chatId)) {
        bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Akses ditolak' });
        return;
    }
    
    if (data === 'confirm_yes' || data === 'confirm_no') {
        const state = userState[chatId];
        
        if (data === 'confirm_no') {
            await bot.sendMessage(chatId, '❌ Dibatalkan.');
            userState[chatId] = null;
            bot.answerCallbackQuery(callbackQuery.id);
            return;
        }
        
        if (state && state.action === 'edit_file') {
            await bot.sendMessage(chatId, '⏳ Mengedit file...');
            const result = await writeFileContent(state.path, state.content);
            if (result.success) {
                await bot.sendMessage(chatId, `✅ File berhasil diedit: ${escapeMarkdown(result.path)}``, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `❌ Gagal: ${result.error}`, { parse_mode: 'Markdown' });
            }
        } else if (state && state.action === 'delete_file') {
            await bot.sendMessage(chatId, '⏳ Menghapus file...');
            const result = await deleteFile(state.path);
            if (result.success) {
                await bot.sendMessage(chatId, `✅ File berhasil dihapus: ${escapeMarkdown(result.path)}``, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `❌ Gagal: ${result.error}`, { parse_mode: 'Markdown' });
            }
        } else if (state && state.action === 'delete_folder') {
            await bot.sendMessage(chatId, '⏳ Menghapus folder...');
            const result = await deleteFolder(state.path);
            if (result.success) {
                await bot.sendMessage(chatId, `✅ Folder berhasil dihapus: ${escapeMarkdown(result.path)}``, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `❌ Gagal: ${result.error}`, { parse_mode: 'Markdown' });
            }
        } else if (state && state.action === 'shutdown') {
            await bot.sendMessage(chatId, '⏳ Mematikan laptop...');
            await executeShutdown();
            await bot.sendMessage(chatId, `⚠️ Laptop akan dimatikan dalam 60 detik...\n\nKetik "batal" untuk membatalkan.`);
        } else if (state && state.action === 'restart') {
            await bot.sendMessage(chatId, '⏳ Merestart laptop...');
            await executeRestart();
            await bot.sendMessage(chatId, `⚠️ Laptop akan direstart dalam 60 detik...\n\nKetik "batal" untuk membatalkan.`);
        }
        
        userState[chatId] = null;
    } else if (data.startsWith('close_')) {
        const parts = data.replace('close_', '').split('_');
        const pid = parts[0];
        const name = decodeURIComponent(parts.slice(1).join('_'));
        
        await bot.answerCallbackQuery(callbackQuery.id, { text: '⏳ Menutup...' });
        
        const closeResult = await closeWindow(pid, name);
        
        if (closeResult.success) {
            await bot.sendMessage(chatId, `✅ "${name}" berhasil ditutup!`, { parse_mode: 'Markdown' });
        } else {
            await bot.sendMessage(chatId, `❌ Gagal menutup "${name}": ${closeResult.error}`, { parse_mode: 'Markdown' });
        }
        
        const windowResult = await getOpenWindows();
        if (windowResult.success && windowResult.windows.length > 0) {
            await sendResponse(chatId, { action: 'list_tabs', windows: windowResult.windows });
        }
    } else if (data === 'refresh_tabs') {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '⏳ Refresh...' });
        
        const windowResult = await getOpenWindows();
        if (windowResult.success) {
            if (windowResult.windows.length === 0) {
                await bot.sendMessage(chatId, `📭 Tidak ada tab/jendela yang ditemukan.`, { parse_mode: 'Markdown' });
            } else {
                const uniqueWindows = [];
                const seen = new Set();
                windowResult.windows.forEach(w => {
                    const key = w.name.toLowerCase();
                    if (!seen.has(key)) {
                        seen.add(key);
                        uniqueWindows.push(w);
                    }
                });
                await sendResponse(chatId, { action: 'list_tabs', windows: uniqueWindows });
            }
        } else {
            await bot.sendMessage(chatId, `❌ Gagal mengambil daftar tab: ${windowResult.error}`, { parse_mode: 'Markdown' });
        }
    } else if (data.startsWith('openfile_')) {
        const filePath = decodeURIComponent(data.replace('openfile_', ''));
        await bot.answerCallbackQuery(callbackQuery.id, { text: '⏳ Membuka file...' });
        
        const result = await openVSCodeWithFile(filePath);
        if (result.success) {
            await bot.sendMessage(chatId, `✅ File terbuka di VSCode!\n📄 ${escapeMarkdown(filePath)}``, { parse_mode: 'Markdown' });
        } else {
            await bot.sendMessage(chatId, `❌ Gagal membuka file: ${result.error}`, { parse_mode: 'Markdown' });
        }
    } else if (data.startsWith('openfolder_')) {
        const folderPath = decodeURIComponent(data.replace('openfolder_', ''));
        await bot.answerCallbackQuery(callbackQuery.id, { text: '⏳ Membuka folder...' });
        
        exec(`code "${folderPath}"`, { shell: 'cmd.exe' }, (err) => {
            if (err) {
                bot.sendMessage(chatId, `❌ Gagal membuka folder: ${escapeMarkdown(err.message)}`, { parse_mode: 'Markdown' }).catch(() => {});
            } else {
                bot.sendMessage(chatId, `✅ Folder terbuka di VSCode!\n📂 ${escapeMarkdown(folderPath)}``, { parse_mode: 'Markdown' }).catch(() => {});
            }
        });
    } else if (data.startsWith('yt_')) {
        const parts = data.split('_');
        const action = parts[1];
        const videoId = parts[2];
        
        if (!videoId) {
            bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Video tidak ditemukan' });
            return;
        }
        
        const videoInfo = activeVideos[${chatId}_${videoId}`];
        
        if (action === 'play') {
            await bot.answerCallbackQuery(callbackQuery.id, { text: '▶️ Membuka video...' });
            const url = `https://www.youtube.com/watch?v=${videoId}`;
            const openCmd = osType === 'Windows' 
                ? `Start-Process -FilePath "${url}"`
                : `open "${url}"`;
            exec(openCmd, { shell: osType === 'Windows' ? 'powershell.exe' : '/bin/bash' }, (err) => {
                if (err) {
                    bot.sendMessage(chatId, `❌ Gagal membuka video: ${err.message}`).catch(() => {});
                }
            });
            
        } else if (action === 'goto') {
            await bot.answerCallbackQuery(callbackQuery.id, { text: '⏩ Pilih durasi lompatan...' });
            
            const goToKeyboard = {
                inline_keyboard: [
                    [
                        { text: '⏪ 10 Detik', callback_data: `yt_skip_${videoId}_10` },
                        { text: '⏪ 30 Detik', callback_data: `yt_skip_${videoId}_30` }
                    ],
                    [
                        { text: '⏩ 1 Menit', callback_data: `yt_skip_${videoId}_60` },
                        { text: '⏩ 5 Menit', callback_data: `yt_skip_${videoId}_300` }
                    ],
                    [
                        { text: '⏩ 10 Menit', callback_data: `yt_skip_${videoId}_600` }
                    ],
                    [
                        { text: '🔙 Kembali', callback_data: `yt_back_${videoId} }
                    ]
                ]
            };
            
            bot.editMessageReplyMarkup(goToKeyboard, { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
            
        } else if (action === 'back' && videoInfo) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: '🔙 Kembali ke kontrol video' });
            
            const playKeyboard = {
                inline_keyboard: [
                    [
                        { text: '▶️ PLAY', callback_data: `yt_play_${videoId} },
                        { text: '⏹️ STOP', callback_data: `yt_stop_${videoId} }
                    ],
                    [
                        { text: '⏭️ GO TO', callback_data: `yt_goto_${videoId} }
                    ]
                ]
            };
            
            const desc = videoInfo.description.length > 200 
                ? videoInfo.description.substring(0, 200) + '...' 
                : videoInfo.description;
            
            const infoText = `▶️ *Video: ${escapeMarkdown(videoInfo.title)}*\n\n📝 *Deskripsi:*\n${escapeMarkdown(desc)}\n\n🎮 *Control Panel:*`;
            
            bot.editMessageText(infoText, {
                chat_id: chatId,
                message_id: msg.message_id,
                parse_mode: 'Markdown',
                reply_markup: JSON.stringify(playKeyboard)
            }).catch(() => {});
            
        } else if (action === 'stop') {
            await bot.answerCallbackQuery(callbackQuery.id, { text: '⏹️ Tidak dapat menghentikan video eksternal' });
            await bot.sendMessage(chatId, 'ℹ️ Video diputar di browser. Tutup tab browser untuk menghentikan.');
        }
    } else if (data.startsWith('yt_skip_')) {
        const parts = data.replace('yt_skip_', '').split('_');
        const videoId = parts[0];
        const seconds = parseInt(parts[1]) || 0;
        
        await bot.answerCallbackQuery(callbackQuery.id, { text: `⏩ Melompat ${seconds} detik...` });
        
        const url = `https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`;
        const openCmd = osType === 'Windows' 
            ? `Start-Process -FilePath "${url}"`
            : `open "${url}"`;
        exec(openCmd, { shell: osType === 'Windows' ? 'powershell.exe' : '/bin/bash' }, (err) => {
            if (err) {
                bot.sendMessage(chatId, `❌ Gagal membuka video: ${err.message}`).catch(() => {});
            }
        });
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
});

process.on('SIGINT', () => {
    console.log('\n🤖 Omira AI Agent dihentikan...');
    bot.stopPolling();
    process.exit(0);
});
