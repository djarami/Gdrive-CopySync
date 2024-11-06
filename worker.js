// Force Node.js to use the newer URL implementation
const { URL } = require('url');
global.URL = URL;

// Remove any existing warning handlers
process.removeAllListeners('warning');

const { parentPort } = require('worker_threads');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs-extra');

// Handle file upload task
parentPort.on('message', async ({ file, auth, targetFolderId, folderPath }) => {
  try {
    // Create a new OAuth2 client with the credentials
    const oauth2Client = new OAuth2Client(
      auth._clientId,
      auth._clientSecret,
      'http://localhost'
    );
    
    // Set credentials
    oauth2Client.setCredentials(auth.credentials);
    
    // Create drive instance with auth
    const drive = google.drive({ 
      version: 'v3', 
      auth: oauth2Client
    });
    
    // Create folder structure if needed
    const finalFolderId = await ensureFolderPath(drive, folderPath, targetFolderId);
    
    // Upload file
    const response = await drive.files.create({
      requestBody: {
        name: file.name,
        parents: [finalFolderId]
      },
      media: {
        body: fs.createReadStream(file.fullPath)
      }
    });

    parentPort.postMessage({ success: true, file: file.path });
  } catch (error) {
    parentPort.postMessage({ 
      success: false, 
      file: file.path, 
      error: error.message || 'Unknown error occurred'
    });
  }
});

async function ensureFolderPath(drive, folderPath, parentId) {
  if (!folderPath) return parentId;
  
  const parts = folderPath.split('/');
  let currentParentId = parentId;
  
  for (const part of parts) {
    try {
      const response = await drive.files.list({
        q: `'${currentParentId}' in parents and name = '${part}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)'
      });
      
      if (response.data.files.length > 0) {
        currentParentId = response.data.files[0].id;
      } else {
        const newFolder = await drive.files.create({
          requestBody: {
            name: part,
            parents: [currentParentId],
            mimeType: 'application/vnd.google-apps.folder'
          }
        });
        currentParentId = newFolder.data.id;
      }
    } catch (error) {
      console.error(`Error processing folder ${part}:`, error.message);
      throw error;
    }
  }
  
  return currentParentId;
} 