const fs = require('fs-extra');
const path = require('path');
const { authenticate } = require('@google-cloud/local-auth');
const { google } = require('googleapis');
const cliProgress = require('cli-progress');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/drive'];

async function authorize() {
  const auth = await authenticate({
    keyfilePath: path.join(__dirname, 'credentials.json'),
    scopes: SCOPES,
  });
  return auth;
}

async function listDriveFiles(drive, folderId) {
  const files = [];
  let pageToken = null;

  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      pageToken: pageToken,
    });
    files.push(...response.data.files);
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function listLocalFiles(localFolderPath) {
  const files = [];
  const items = await fs.readdir(localFolderPath, { withFileTypes: true });
  
  for (const item of items) {
    if (item.isFile()) {
      const filePath = path.join(localFolderPath, item.name);
      const stats = await fs.stat(filePath);
      files.push({
        name: item.name,
        path: filePath,
        size: stats.size
      });
    }
  }
  
  return files;
}

async function uploadFile(drive, filePath, fileName, targetFolderId) {
  try {
    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [targetFolderId]
      },
      media: {
        body: fs.createReadStream(filePath)
      }
    });
    return response.data;
  } catch (error) {
    console.error(`Error uploading file ${fileName}:`, error.message);
    throw error;
  }
}

async function syncFolders(localFolderPath, targetFolderId) {
  try {
    // Authenticate
    const auth = await authorize();
    const drive = google.drive({ version: 'v3', auth });

    // Get local files
    console.log('Scanning local files...');
    const localFiles = await listLocalFiles(localFolderPath);
    console.log(`Found ${localFiles.length} local files`);
    
    // Get target files in Drive
    console.log('Fetching Drive files...');
    const driveFiles = await listDriveFiles(drive, targetFolderId);
    const driveFileNames = new Set(driveFiles.map(file => file.name));
    console.log(`Found ${driveFiles.length} files in Drive`);

    // Find files to sync and skip
    const filesToSync = localFiles.filter(file => !driveFileNames.has(file.name));
    const filesToSkip = localFiles.filter(file => driveFileNames.has(file.name));
    
    // Show skipped files
    console.log('\nSkipping existing files:');
    filesToSkip.forEach(file => {
      console.log(`- ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    });
    
    console.log(`\nFound ${filesToSync.length} files to sync`);
    
    // Create progress bar
    const progressBar = new cliProgress.SingleBar({
      format: 'Progress |{bar}| {percentage}% | {value}/{total} Files | {file}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
    });
    progressBar.start(filesToSync.length, 0, { file: '' });

    // Upload files that don't exist in target
    for (let i = 0; i < filesToSync.length; i++) {
      const file = filesToSync[i];
      progressBar.update(i, { file: `Copying: ${file.name}` });
      await uploadFile(drive, file.path, file.name, targetFolderId);
      progressBar.update(i + 1, { file: `Copied: ${file.name}` });
    }

    progressBar.stop();
    
    // Show summary
    console.log('\nSync Summary:');
    console.log(`- Files copied: ${filesToSync.length}`);
    console.log(`- Files skipped: ${filesToSkip.length}`);
    console.log(`- Total files processed: ${localFiles.length}`);
    console.log('\nSync completed successfully!');

  } catch (error) {
    console.error('Sync failed:', error);
  }
}

// Load config
const config = require('./config.json');

syncFolders(config.localFolderPath, config.targetFolderId);