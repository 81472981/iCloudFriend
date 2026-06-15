import Foundation

@MainActor
final class DestinationBookmarkStore: ObservableObject {
    @Published private(set) var destinationURL: URL?
    @Published private(set) var bookmarkIsStale = false

    private let bookmarkKey = "iCloudFriend.destinationBookmark"

    var destinationLabel: String {
        destinationURL?.lastPathComponent ?? "No SMB folder selected"
    }

    func resolveStoredBookmark() {
        guard let data = UserDefaults.standard.data(forKey: bookmarkKey) else {
            destinationURL = nil
            return
        }

        do {
            var isStale = false
            let url = try URL(
                resolvingBookmarkData: data,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            destinationURL = url
            bookmarkIsStale = isStale
        } catch {
            destinationURL = nil
            bookmarkIsStale = true
        }
    }

    func save(url: URL) {
        do {
            let data = try url.bookmarkData(
                options: [],
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
            UserDefaults.standard.set(data, forKey: bookmarkKey)
            destinationURL = url
            bookmarkIsStale = false
        } catch {
            destinationURL = url
            bookmarkIsStale = true
        }
    }

    func clear() {
        UserDefaults.standard.removeObject(forKey: bookmarkKey)
        destinationURL = nil
        bookmarkIsStale = false
    }

    func access<T>(_ body: (URL) async throws -> T) async throws -> T {
        guard let destinationURL else {
            throw BackupError.noDestination
        }

        let didStart = destinationURL.startAccessingSecurityScopedResource()
        defer {
            if didStart {
                destinationURL.stopAccessingSecurityScopedResource()
            }
        }

        return try await body(destinationURL)
    }
}
