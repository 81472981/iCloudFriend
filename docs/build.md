# Build Notes

## iOS App

Open the Xcode project:

```text
ios/iCloudFriend/iCloudFriend.xcodeproj
```

Requirements:

- Xcode 16 or newer
- iOS 17 or newer deployment target
- a physical iPhone for Photos library and SMB Files provider testing

The app uses public Apple frameworks only:

- SwiftUI
- Photos
- UniformTypeIdentifiers
- CryptoKit

iOS does not expose a general public SMB socket API for third-party apps. The app therefore uses the system Files provider: the user connects to the Windows SMB share in Files, then grants this app folder access with the document picker. The actual transfer still goes over SMB/NAS, handled by iOS.

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

## SMB Share Permissions

Creating or repairing a Windows SMB share requires administrator approval. The Windows app starts an elevated PowerShell command only for that specific action. Normal monitoring, folder selection, and UI usage do not require elevation.

The recommended setup is:

- share name: `iCloudFriend`
- path: a folder under `Pictures` or a dedicated backup drive
- access: the current Windows user has change access
- iPhone connects with that Windows username and password
