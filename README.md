# iCloudFriend

iCloudFriend is a two-part backup system for moving original iCloud Photos assets from an iPhone to a Windows PC over the local network.

- `ios/iCloudFriend`: SwiftUI iOS app. It discovers the Windows receiver with Bonjour, downloads original iCloud resources when needed, and uploads files plus metadata over local TLS.
- `windows`: Electron desktop app for Windows. It runs a Bonjour-advertised TLS receiver, stores incoming backups under the chosen folder, optionally creates/repairs an SMB share for NAS-style browsing, monitors incoming backups, and packages as a real `.exe`.
- `docs`: shared protocol, backup format, and build notes.

## What Gets Backed Up

Each asset is stored under the `Backup/.icloudfriend` folder managed by the Windows app:

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

- Full sync scans the whole photo library and refreshes every asset on the Windows receiver. Existing completed resources are reused.
- Incremental sync compares the Photos asset fingerprint with local state and the Windows receiver's metadata, then uploads only changed or never-backed-up assets.
- Interrupted transfers resume from the receiver's existing `.partial` file length and finish with an atomic rename.

## Quick Start

1. On Windows, run the desktop app and choose a backup folder.
2. Keep the Windows app open. It starts a local TLS receiver and advertises `_icloudfriend._tcp` with Bonjour.
3. On iPhone, open iCloudFriend on the same Wi-Fi. Select the discovered Windows receiver.
4. Start `Full sync` the first time. Use `Incremental sync` after that.
5. Optional: click `Create SMB Share` in the Windows app if you also want to browse the backup folder from Files/NAS tools.

Build details are in [docs/build.md](docs/build.md), the on-disk protocol is in [docs/backup-format.md](docs/backup-format.md), the business plan deck is in [docs/iCloudFriend商业计划书.pptx](docs/iCloudFriend商业计划书.pptx), and the product development plan is in [docs/product-development-plan.zh.md](docs/product-development-plan.zh.md).
