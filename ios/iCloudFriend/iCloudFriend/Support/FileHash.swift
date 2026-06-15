import CryptoKit
import Foundation

enum FileHash {
    static func sha256Hex(for url: URL) throws -> (hash: String, byteCount: Int64) {
        guard let stream = InputStream(url: url) else {
            throw CocoaError(.fileReadNoSuchFile)
        }

        stream.open()
        defer { stream.close() }

        var hasher = SHA256()
        var total: Int64 = 0
        let bufferSize = 1024 * 1024
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }

        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: bufferSize)
            if read < 0 {
                throw stream.streamError ?? CocoaError(.fileReadUnknown)
            }
            if read == 0 {
                break
            }
            hasher.update(bufferPointer: UnsafeRawBufferPointer(start: buffer, count: read))
            total += Int64(read)
        }

        let digest = hasher.finalize()
        return (digest.map { String(format: "%02x", $0) }.joined(), total)
    }
}
