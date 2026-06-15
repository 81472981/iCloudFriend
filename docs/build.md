# Build Notes

## iOS App

Open the Xcode project:

```text
ios/iCloudFriend/iCloudFriend.xcodeproj
```

Requirements:

- Xcode 16 or newer
- iOS 17 or newer deployment target
- a physical iPhone for Photos library, Bonjour discovery, and local network transfer testing

The app uses public Apple frameworks only:

- SwiftUI
- Photos
- UniformTypeIdentifiers
- CryptoKit
- Foundation networking and Bonjour (`NetServiceBrowser`)

iOS discovers the Windows app with Bonjour (`_icloudfriend._tcp`) and uploads to the Windows receiver over local HTTPS/TLS. The iOS app declares `NSLocalNetworkUsageDescription` and `NSBonjourServices`, so the first device scan asks for local network permission.

The legacy SMB/NAS share remains optional for browsing and interoperability. The main backup path no longer requires the iOS document picker.

## Windows App

From the `windows` folder:

```bash
npm install
npm run start
```

To create a Windows `.exe` package on Windows:

```bash
npm run dist:win
```

The build creates a packaged Electron desktop executable under:

```text
windows/dist/
```

This is a real Windows GUI application. It is not launched through a BAT file.

At runtime the Windows app starts:

- a Bonjour service: `_icloudfriend._tcp`
- a local HTTPS receiver with a self-signed certificate and TLS 1.3 minimum
- upload APIs for resource status, chunked resource append, asset metadata commit, and receiver health
- filesystem monitoring under `Backup/.icloudfriend`

## SMB Share Permissions

Creating or repairing a Windows SMB share requires administrator approval. The Windows app starts an elevated PowerShell command only for that specific action. Normal monitoring, folder selection, and UI usage do not require elevation.

The recommended setup is:

- share name: `iCloudFriend`
- share path: a folder under `Pictures` or a dedicated backup drive
- iPhone target folder: `Backup` inside the share
- access: the current Windows user has change access
- iPhone backup does not require SMB credentials when using the automatic receiver
