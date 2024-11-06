# Drive Sync

A Node.js application that syncs files from a local folder to Google Drive.

## Features
- One-way sync from local folder to Google Drive
- Progress bar showing sync status
- Skips existing files
- Handles large folders with pagination

## Prerequisites
- Node.js installed on your computer
- Google Cloud Console account
- Google Drive API enabled
- OAuth 2.0 credentials

## Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Get Google Drive API Credentials**
   1. Go to [Google Cloud Console](https://console.cloud.google.com/)
   2. Create a new project or select existing one
   3. Enable the Google Drive API:
      - Navigate to "APIs & Services" > "Library"
      - Search for "Google Drive API"
      - Click "Enable"
   4. Create credentials:
      - Go to "APIs & Services" > "Credentials"
      - Click "Create Credentials" > "OAuth client ID"
      - Select "Desktop app" as application type
      - Name it (e.g., "Drive Sync App")
      - Click "Create"
   5. Download the credentials file
   6. Rename it to `credentials.json`
   7. Place it in the project root directory
   8. Configure OAuth consent screen:
      - Go to "OAuth consent screen" in Google Cloud Console
      - Fill in the required information
      - Add your email as a test user under "Test users"
      - Save changes

3. **Configure Sync Folders**
   Copy `config-example.json` to `config.json` and update the values:
   ```bash
   cp config-example.json config.json
   ```
   Then edit `config.json` with your paths:
   ```json
   {
       "localFolderPath": "/path/to/your/local/folder",
       "targetFolderId": "your_google_drive_folder_id"
   }
   ```

   To get your Google Drive folder ID:
   1. Open the target folder in Google Drive
   2. The folder ID is in the URL: `https://drive.google.com/drive/folders/FOLDER_ID_HERE`

## Project Structure
```
drive-sync/
  ├── drive-sync.js    # Main application code
  ├── package.json     # Dependencies and scripts
  ├── config.json      # Configuration settings
  ├── credentials.json # Google API credentials
  └── README.md       # This file
```

## Usage

Run the sync with:
```bash
npm start
```

On first run, it will:
1. Open a browser window for Google authentication
2. Ask for permission to access your Google Drive
3. Start syncing files from local folder to Drive

## Notes
- Only syncs files, not folders (yet)
- Skips files that already exist in the target Drive folder
- Shows progress bar during sync
- Logs errors if any files fail to sync