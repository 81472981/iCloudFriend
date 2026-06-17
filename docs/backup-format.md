# Backup Format

The backup root is the `Backup` folder managed by the Windows app. iOS uploads resources to the Windows receiver, and the receiver keeps its canonical transfer state under `.icloudfriend`. After each asset is committed, the Windows app mirrors the original files and a JSON sidecar into the visible `Photos` folder so users can open the backup directory and immediately see their photos.

```text
<iCloudFriend share>/Backup/
  Photos/
    <year>/
      <month>/
        <asset-key>/
          <original resource files>
          metadata.json
  .icloudfriend/
    assets/
      <year>/
        <month>/
          <asset-key>/
            metadata.json
            resources/
              <original resource files>
    index/
      events.ndjson
```

## Asset Key

The iOS app creates an asset key from:

- the Photos `localIdentifier`, hashed with SHA-256
- the original filename when available

This keeps folder names stable while avoiding illegal path characters from `localIdentifier`.

## Resource Writes

Resources are first written to the internal transfer location:

```text
resources/<filename>.partial
```

When export completes successfully, the file is atomically renamed to:

```text
resources/<filename>
```

If a transfer is interrupted, the next sync asks the Windows receiver for the `.partial` length and uploads only the remaining bytes. Completed files are hashed with SHA-256 and reused. Once the asset metadata is committed, the Windows app mirrors the completed resource into:

```text
Photos/<year>/<month>/<asset-key>/<filename>
```

The mirror uses a hard link when possible and falls back to copying the file.

## Metadata Sidecar

Each `metadata.json` contains:

- asset identity and fingerprint
- media type and subtype values from Photos
- creation and modification timestamps
- dimensions and video duration
- favorite/hidden flags
- location fields: latitude, longitude, altitude, accuracy, speed, course, and timestamp
- every exported resource with original filename, resource type, UTI, byte length, SHA-256, and backup path
- backup timestamp and app format version

The original files usually retain embedded EXIF/QuickTime metadata. The sidecar exists so Windows can restore or audit metadata even when a file format does not preserve all Photos library fields.

## Incremental State

The iOS app keeps a local JSON state file in Application Support:

```text
sync-state.json
```

For incremental sync, it skips an asset only when the stored fingerprint still matches the current Photos asset and the Windows receiver confirms the matching metadata exists. Full sync scans all assets and refreshes the sidecar, but still avoids rewriting completed resources.

## Windows Monitoring

The Windows desktop app treats the internal `metadata.json` as the authoritative completion marker for an asset folder. It scans and watches `.icloudfriend/assets` to show:

- total assets
- total bytes
- recent completed backups
- receiver status, share status, and connection details
