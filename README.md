# iCloudFriend

iCloudFriend is a two-part backup system for moving the original assets from iCloud Photos on an iPhone to a Windows PC over an SMB/NAS share.

- `ios/iCloudFriend`: SwiftUI iOS app. It reads the user's Photos library, downloads original iCloud resources when needed, and writes files plus metadata to a selected SMB/NAS folder.
- `windows`: Electron desktop app for Windows. It creates/repairs the SMB share, shows connection details, monitors incoming backups, and packages as a real `.exe`.
- `docs`: shared protocol, backup format, and build notes.

## What Gets Backed Up

Each asset is stored as a folder under the `Backup` folder inside the Windows share:

```text
.icloudfriend/
  assets/
    2026/
      06/
        4d2c...-IMG_1234/
          metadata.json
          resources/
            IMG_1234.HEIC
            IMG_1234.MOV
```

The app exports all available `PHAssetResource` entries for an asset, including original photos, videos, paired Live Photo movies, adjustment data, and full-size resources when Photos exposes them. A JSON sidecar preserves timestamps, location, dimensions, favorite/hidden flags, media type, and resource checksums.

## Sync Modes

- Full sync scans the whole photo library and verifies every asset folder on the SMB share. Existing completed resources are reused.
- Incremental sync compares the Photos asset fingerprint with the local sync state and uploads only changed or never-backed-up assets.
- Interrupted transfers resume from the existing `.partial` file length and finish with an atomic rename.

## Quick Start

1. On Windows, run the desktop app from `windows` and choose a backup folder.
2. Click `Create SMB Share` in the Windows app. Windows will ask for administrator approval because creating an SMB share requires it.
3. On iPhone, open the Files app and connect to `smb://<PC-NAME>/iCloudFriend`.
4. In the iOS app, open `Choose Folder`, enter the connected share, and choose the `Backup` folder inside it. iOS may not allow selecting the SMB share root itself.
5. Start `Full sync` the first time. Use `Incremental sync` after that.

Build details are in [docs/build.md](docs/build.md), the on-disk protocol is in [docs/backup-format.md](docs/backup-format.md), the business plan deck is in [docs/iCloudFriend商业计划书.pptx](docs/iCloudFriend商业计划书.pptx), and the product development plan is in [docs/product-development-plan.zh.md](docs/product-development-plan.zh.md).
