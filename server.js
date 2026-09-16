const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5050;

// Resolve external directory using an environment variable or relative parent path
const STORIES_DIR = process.env.AUDIO_DIR
  ? path.resolve(process.env.AUDIO_DIR)
  : path.resolve(__dirname, '..', 'audio', 'stories');

// Secret key for HMAC token generation
const SECRET_KEY = crypto.randomBytes(32).toString('hex');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: Format string into human-readable title
function formatTitle(str) {
  return str
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\.\w+$/, '');
}

// Helper: Generate secure authorization token for a story
function generateToken(storyId) {
  return crypto.createHmac('sha256', SECRET_KEY).update(storyId).digest('hex');
}

// Helper: Read single story directory and parse config/PIN/Image URL
function getStoryMetadata(folderName) {
  const storyPath = path.join(STORIES_DIR, folderName);
  if (!fs.existsSync(storyPath) || !fs.statSync(storyPath).isDirectory()) {
    return null;
  }

  let title = formatTitle(folderName);
  let author = 'Audiobook';
  let pin = '0000';
  let imageUrl = null;

  const configPath = path.join(storyPath, 'config.json');
  const pinPath = path.join(storyPath, 'pin.txt');
  const coverTxtPath = path.join(storyPath, 'cover.txt');

  // 1. Check config.json
  if (fs.existsSync(configPath)) {
    try {
      const conf = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (conf.title) title = conf.title;
      if (conf.author) author = conf.author;
      if (conf.pin !== undefined) pin = String(conf.pin).trim();
      if (conf.coverUrl || conf.imageUrl) imageUrl = conf.coverUrl || conf.imageUrl;
    } catch (err) {
      console.error(`Error parsing config.json in ${folderName}:`, err);
    }
  } 
  // 2. Fallback to pin.txt
  else if (fs.existsSync(pinPath)) {
    try {
      pin = fs.readFileSync(pinPath, 'utf8').trim();
    } catch (err) {
      console.error(`Error reading pin.txt in ${folderName}:`, err);
    }
  }

  // 3. Check cover.txt if no URL was set in config.json
  if (!imageUrl && fs.existsSync(coverTxtPath)) {
    try {
      imageUrl = fs.readFileSync(coverTxtPath, 'utf8').trim();
    } catch (err) {
      console.error(`Error reading cover.txt in ${folderName}:`, err);
    }
  }

  // Determine lock status (0000 or empty means unlocked)
  const isLocked = pin !== '0000' && pin !== '';

  // Scan Audio Files
  const files = fs.readdirSync(storyPath);
  const audioExtensions = ['.mp3', '.m4a', '.wav', '.aac'];
  
  const episodes = files
    .filter((f) => audioExtensions.includes(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map((filename) => ({
      filename,
      title: formatTitle(path.parse(filename).name)
    }));

  return {
    id: folderName,
    title,
    author,
    pin, // Internal only, stripped before API output
    imageUrl,
    isLocked,
    episodes
  };
}

// Helper: Scan all stories in stories folder
function scanAllStories() {
  if (!fs.existsSync(STORIES_DIR)) {
    fs.mkdirSync(STORIES_DIR, { recursive: true });
  }

  const folders = fs.readdirSync(STORIES_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  return folders.map(getStoryMetadata).filter(Boolean);
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// 1. GET /api/stories - Return list of stories without sensitive PIN field
app.get('/api/stories', (req, res) => {
  const stories = scanAllStories();
  
  const safeStories = stories.map(({ pin, imageUrl, ...rest }) => ({
    ...rest,
    coverUrl: imageUrl || `/api/stories/${rest.id}/cover`,
    episodeCount: rest.episodes.length
  }));

  res.json(safeStories);
});

// 2. POST /api/stories/:storyId/unlock - Validate PIN & Return Token
app.post('/api/stories/:storyId/unlock', (req, res) => {
  const safeStoryId = path.basename(req.params.storyId);
  const { pin } = req.body || {};

  const story = getStoryMetadata(safeStoryId);
  if (!story) {
    return res.status(404).json({ success: false, message: 'Story not found' });
  }

  if (!story.isLocked || story.pin === String(pin).trim()) {
    const token = generateToken(safeStoryId);
    return res.json({ success: true, token });
  }

  return res.status(401).json({ success: false, message: 'Incorrect PIN. Please try again.' });
});

// 3. GET /api/stories/:storyId/cover - Redirect to URL, Serve Local File, or Fallback SVG
app.get('/api/stories/:storyId/cover', (req, res) => {
  const safeStoryId = path.basename(req.params.storyId);
  const storyPath = path.join(STORIES_DIR, safeStoryId);
  const story = getStoryMetadata(safeStoryId);

  // Direct redirect if external image URL exists
  if (story && story.imageUrl) {
    return res.redirect(story.imageUrl);
  }

  // Serve local image file if present in the story folder
  if (fs.existsSync(storyPath)) {
    const files = fs.readdirSync(storyPath);
    const coverFile = files.find((f) => /^cover\.(jpg|jpeg|png|webp)$/i.test(f));
    if (coverFile) {
      return res.sendFile(path.join(storyPath, coverFile));
    }
  }

  // Generate dynamic SVG fallback cover
  const title = story ? story.title : safeStoryId;
  const svg = `
    <svg width="400" height="400" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#FF334B"/>
          <stop offset="100%" stop-color="#121212"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <circle cx="200" cy="160" r="50" fill="rgba(255,255,255,0.1)"/>
      <path d="M190 140 L220 160 L190 180 Z" fill="#FFFFFF"/>
      <text x="50%" y="270" font-family="Segoe UI, Roboto, sans-serif" font-size="24" font-weight="bold" fill="#ffffff" text-anchor="middle">${title}</text>
      <text x="50%" y="300" font-family="Segoe UI, Roboto, sans-serif" font-size="14" fill="#FF334B" text-anchor="middle">Audiobook AUDIO</text>
    </svg>
  `;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

// 4. GET /api/stories/:storyId/stream/:filename - Stream Audio with HTTP Range Requests
app.get('/api/stories/:storyId/stream/:filename', (req, res) => {
  const safeStoryId = path.basename(req.params.storyId);
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.join(STORIES_DIR, safeStoryId, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Audio file not found');
  }

  // Validate Authorization
  const story = getStoryMetadata(safeStoryId);
  if (!story) return res.status(404).send('Story not found');

  if (story.isLocked) {
    const clientToken = req.query.token || req.headers['authorization']?.replace('Bearer ', '');
    const expectedToken = generateToken(safeStoryId);
    if (clientToken !== expectedToken) {
      return res.status(403).send('Forbidden: Authorization PIN required.');
    }
  }

  // Stream with Partial Content (Range HTTP 206)
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  const ext = path.extname(safeFilename).toLowerCase();
  const mimeTypes = {
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.aac': 'audio/aac'
  };
  const contentType = mimeTypes[ext] || 'audio/mpeg';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
      return res.end();
    }

    const chunkSize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Helper: Auto-seed sample audio files if destination directory is empty
function autoSeedSamplesIfEmpty() {
  const allStories = scanAllStories();
  if (allStories.length === 0) {
    console.log('No stories found. Seeding sample folders and dummy WAV audio files...');

    // Story 1: Shadows In The Dark (Locked with PIN 1234 & config image)
    const folder1 = path.join(STORIES_DIR, 'shadows-in-the-dark');
    fs.mkdirSync(folder1, { recursive: true });
    fs.writeFileSync(
      path.join(folder1, 'config.json'),
      JSON.stringify({ 
        title: 'Shadows in the Dark', 
        author: 'John Doe', 
        pin: '1234',
        coverUrl: 'https://picsum.photos/400/400'
      }, null, 2)
    );

    // Story 2: Romantic Vibes (Locked with pin.txt & cover.txt)
    const folder2 = path.join(STORIES_DIR, 'romantic-vibes');
    fs.mkdirSync(folder2, { recursive: true });
    fs.writeFileSync(path.join(folder2, 'pin.txt'), '5678');
    fs.writeFileSync(path.join(folder2, 'cover.txt'), 'https://picsum.photos/400/400?grayscale');

    // Create playable dummy WAV files (3-second sine wave tone)
    const dummyWav = createDummyWavBuffer();
    fs.writeFileSync(path.join(folder1, '01_The_Beginning.wav'), dummyWav);
    fs.writeFileSync(path.join(folder1, '02_The_Confrontation.wav'), dummyWav);
    fs.writeFileSync(path.join(folder2, 'episode1.wav'), dummyWav);
    fs.writeFileSync(path.join(folder2, 'episode2.wav'), dummyWav);
    console.log('Sample stories initialized successfully!');
  }
}

// Generate valid 16-bit PCM WAV audio buffer
function createDummyWavBuffer() {
  const sampleRate = 22050;
  const numSamples = sampleRate * 3; // 3 Seconds
  const buffer = Buffer.alloc(44 + numSamples * 2);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * 440 * t) * 12000;
    buffer.writeInt16LE(Math.floor(sample), 44 + i * 2);
  }
  return buffer;
}

app.listen(PORT, () => {
  autoSeedSamplesIfEmpty();
  console.log(`Target Stories Directory: ${STORIES_DIR}`);
  console.log(`Audiobook Audio Application running on http://localhost:${PORT}`);
});
