// Force Node.js to use the newer URL implementation
const { URL } = require('url');
global.URL = URL;

// Remove any existing warning handlers
process.removeAllListeners('warning');

// Rest of your imports
const fs = require('fs-extra');
const path = require('path');
const { authenticate } = require('@google-cloud/local-auth');
const { google } = require('googleapis');
const cliProgress = require('cli-progress');
const micromatch = require('micromatch');
const { Worker } = require('worker_threads');
const os = require('os');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/drive'];

async function authorize() {
  const auth = await authenticate({
    keyfilePath: path.join(__dirname, 'credentials.json'),
    scopes: SCOPES,
  });
  return auth;
}

async function listDriveFiles(drive, folderId, path = '', skipPatterns = []) {
  // First check if this folder should be skipped
  if (shouldSkipPath(path, skipPatterns)) {
    console.log(`Skipping excluded Drive folder: ${path}`);
    return [];
  }

  const files = [];
  let pageToken = null;
  let pageCount = 0;

  console.log(`\nScanning Drive folder${path ? ` "${path}"` : ''}...`);
  
  do {
    pageCount++;
    console.log(`Fetching page ${pageCount} of files...`);
    
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      pageToken: pageToken,
      pageSize: 1000
    });

    const currentFiles = response.data.files;
    console.log(`Found ${currentFiles.length} files on page ${pageCount}`);

    for (const file of currentFiles) {
      const filePath = path ? `${path}/${file.name}` : file.name;
      
      // Skip if the file path matches skip patterns
      if (shouldSkipPath(filePath, skipPatterns)) {
        console.log(`Skipping excluded Drive file/folder: ${filePath}`);
        continue;
      }

      if (file.mimeType === 'application/vnd.google-apps.folder') {
        console.log(`Scanning subfolder: ${filePath}`);
        const subFiles = await listDriveFiles(drive, file.id, filePath, skipPatterns);
        files.push(...subFiles);
      } else {
        files.push({ ...file, path: filePath });
      }
    }
    
    pageToken = response.data.nextPageToken;
    if (pageToken) {
      console.log('More files exist, continuing to next page...');
    }
  } while (pageToken);

  console.log(`Completed scanning "${path || 'root'}" (${files.length} total files found)`);
  return files;
}

function shouldSkipPath(filePath, skipPatterns) {
    if (!skipPatterns || skipPatterns.length === 0) return false;

    // Normalize path separators to forward slashes
    const normalizedPath = filePath.replace(/\\/g, '/');
    
    // Check if any part of the path matches the skip patterns
    return skipPatterns.some(pattern => {
        // Remove any trailing wildcards for directory matching
        const cleanPattern = pattern.replace(/\/\*$/, '');
        
        // Check if the pattern appears anywhere in the path
        return normalizedPath.includes(`/${cleanPattern}`) || 
               normalizedPath.includes(`${cleanPattern}/`) ||
               normalizedPath === cleanPattern;
    });
}

async function listLocalFolders(localFolderPath, skipPatterns = []) {
  const folders = [];
  try {
    const items = await fs.readdir(localFolderPath, { withFileTypes: true });
    
    for (const item of items) {
      if (item.isDirectory()) {
        const fullPath = path.join(localFolderPath, item.name);
        
        if (shouldSkipPath(fullPath, skipPatterns)) {
          console.log(`Skipping excluded folder: ${fullPath}`);
          continue;
        }

        folders.push({
          name: item.name,
          path: fullPath
        });
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${localFolderPath}:`, error.message);
  }
  return folders;
}

async function listLocalFilesInFolder(folderPath, basePath = '', skipPatterns = []) {
  const files = [];
  try {
    const items = await fs.readdir(folderPath, { withFileTypes: true });
    
    for (const item of items) {
      const fullPath = path.join(folderPath, item.name);
      const relativePath = basePath ? path.join(basePath, item.name) : item.name;
      
      if (shouldSkipPath(fullPath, skipPatterns)) {
        continue;
      }

      if (item.isFile()) {
        const stats = await fs.stat(fullPath);
        files.push({
          name: item.name,
          path: relativePath,
          fullPath: fullPath,
          size: stats.size
        });
      }
    }
  } catch (error) {
    console.error(`Error reading folder ${folderPath}:`, error.message);
  }
  return files;
}

async function createFolder(drive, folderName, parentId) {
  try {
    const response = await drive.files.create({
      requestBody: {
        name: folderName,
        parents: [parentId],
        mimeType: 'application/vnd.google-apps.folder'
      }
    });
    return response.data.id;
  } catch (error) {
    console.error(`Error creating folder ${folderName}:`, error.message);
    throw error;
  }
}

async function ensureFolderPath(drive, folderPath, parentId) {
  if (!folderPath) return parentId;
  
  const parts = folderPath.split('/');
  let currentParentId = parentId;
  
  for (const part of parts) {
    // Check if folder exists
    const response = await drive.files.list({
      q: `'${currentParentId}' in parents and name = '${part}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)'
    });
    
    if (response.data.files.length > 0) {
      currentParentId = response.data.files[0].id;
    } else {
      currentParentId = await createFolder(drive, part, currentParentId);
    }
  }
  
  return currentParentId;
}

async function uploadFile(drive, filePath, fileName, targetFolderId, folderPath = '') {
  try {
    // Ensure folder structure exists and get final folder ID
    const finalFolderId = await ensureFolderPath(drive, folderPath, targetFolderId);
    
    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [finalFolderId]
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

async function syncFolder(drive, localFolderPath, targetFolderId, basePath = '', skipPatterns = [], auth) {
  try {
    console.log(`\nProcessing folder: ${localFolderPath}`);
    
    // Get local files first (scanning)
    const localFiles = await listLocalFilesInFolder(localFolderPath, basePath, skipPatterns);
    console.log(`Found ${localFiles.length} local files to process`);
    
    if (localFiles.length === 0) {
      console.log('No files to sync in this folder, skipping...');
      return { copied: 0, skipped: 0, total: 0 };
    }

    // Check which files exist in Drive (only for this folder)
    console.log('Checking Drive folder for existing files...');
    const driveFiles = await drive.files.list({
      q: `'${targetFolderId}' in parents and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 1000
    });
    
    const driveFileNames = new Set(driveFiles.data.files.map(file => file.name));

    // Find files to sync and skip
    const filesToSync = localFiles.filter(file => !driveFileNames.has(path.basename(file.path)));
    const filesToSkip = localFiles.filter(file => driveFileNames.has(path.basename(file.path)));
    
    // Show skipped files
    if (filesToSkip.length > 0) {
      console.log('\nSkipping existing files:');
      filesToSkip.forEach(file => {
        console.log(`- ${file.path} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
      });
    }
    
    if (filesToSync.length > 0) {
      console.log(`\nUploading ${filesToSync.length} files`);
      
      // Create progress bar with clearer format
      const progressBar = new cliProgress.SingleBar({
        format: 'Progress |{bar}| {percentage}% | {value}/{total} Files | {currentFile}',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
      });
      progressBar.start(filesToSync.length, 0, { 
        currentFile: 'Starting...'
      });

      // Create worker pool
      const maxWorkers = Math.min(os.cpus().length - 1, 4);
      const workers = Array(maxWorkers).fill(null).map(() => new Worker('./worker.js'));
      let workerIndex = 0;
      let completedFiles = 0;

      // Process files using worker pool
      const promises = filesToSync.map(file => {
        return new Promise((resolve, reject) => {
          const worker = workers[workerIndex];
          workerIndex = (workerIndex + 1) % workers.length;

          worker.on('error', (error) => {
            console.error(`\nWorker error for ${file.path}:`, error);
            reject(error);
          });

          worker.on('exit', (code) => {
            if (code !== 0) {
              reject(new Error(`Worker stopped with exit code ${code}`));
            }
          });

          worker.postMessage({
            file,
            auth: {
              credentials: auth.credentials,
              _clientId: auth._clientId,
              _clientSecret: auth._clientSecret,
              redirect_uri: auth.redirect_uri
            },
            targetFolderId,
            folderPath: path.dirname(file.path) === '.' ? '' : path.dirname(file.path)
          });

          worker.once('message', result => {
            completedFiles++;
            
            // Update progress bar with current status
            if (result.success) {
              progressBar.update(completedFiles, { 
                currentFile: `Copied: ${file.path}`
              });
            } else {
              progressBar.update(completedFiles, { 
                currentFile: `Failed: ${file.path}`
              });
              console.error(`\nError uploading ${file.path}:`, result.error);
            }

            if (result.success) {
              resolve();
            } else {
              reject(new Error(result.error));
            }
          });
        });
      });

      // Wait for all files to complete
      await Promise.allSettled(promises);
      progressBar.stop();

      // Cleanup workers
      await Promise.all(workers.map(worker => worker.terminate()));
    }

    return {
      copied: filesToSync.length,
      skipped: filesToSkip.length,
      total: localFiles.length
    };
  } catch (error) {
    console.error(`Error syncing folder ${localFolderPath}:`, error);
    return { copied: 0, skipped: 0, total: 0 };
  }
}

async function syncFolders(localFolderPath, targetFolderId, skipPatterns = []) {
  try {
    // Authenticate
    const auth = await authorize();
    const drive = google.drive({ version: 'v3', auth });

    // Get list of subfolders
    console.log('Scanning for subfolders...');
    const subfolders = await listLocalFolders(localFolderPath, skipPatterns);
    console.log(`Found ${subfolders.length} subfolders`);

    // First sync root folder
    console.log('\nProcessing root folder...');
    const rootStats = await syncFolder(drive, localFolderPath, targetFolderId, '', skipPatterns, auth);

    // Then process each subfolder
    let totalStats = { ...rootStats };
    
    for (const folder of subfolders) {
      console.log(`\nProcessing subfolder: ${folder.name}`);
      const stats = await syncFolder(drive, folder.path, targetFolderId, folder.name, skipPatterns, auth);
      totalStats.copied += stats.copied;
      totalStats.skipped += stats.skipped;
      totalStats.total += stats.total;
    }

    // Show final summary
    console.log('\nSync Summary:');
    console.log(`- Files copied: ${totalStats.copied}`);
    console.log(`- Files skipped: ${totalStats.skipped}`);
    console.log(`- Total files processed: ${totalStats.total}`);
    console.log('\nSync completed successfully!');

  } catch (error) {
    console.error('Sync failed:', error);
  }
}

// Load config and start sync with skip patterns
const config = require('./config.json');
syncFolders(config.localFolderPath, config.targetFolderId, config.skipPatterns || []);