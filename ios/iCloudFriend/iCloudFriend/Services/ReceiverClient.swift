import Foundation

private struct AssetStatusRequest: Encodable {
    let assetFolder: String
    let fingerprint: String
}

private struct AssetStatusResponse: Decodable {
    let complete: Bool
}

private struct ResourceStatusRequest: Encodable {
    let relativePath: String
    let byteCount: Int64
}

private struct ResourceStatusResponse: Decodable {
    let complete: Bool
    let offset: Int64
}

private struct ResourceUploadResponse: Decodable {
    let complete: Bool
    let offset: Int64
    let retry: Bool?
}

private struct AssetCommitRequest: Encodable {
    let assetFolder: String
    let sidecar: AssetSidecar
    let event: BackupEvent
}

private struct BasicResponse: Decodable {
    let ok: Bool?
}

final class ReceiverClient: NSObject, URLSessionDelegate {
    private let device: ReceiverDevice
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 60 * 60
        configuration.waitsForConnectivity = true
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    init(device: ReceiverDevice) {
        self.device = device
        super.init()
    }

    func hello() async throws {
        var request = URLRequest(url: endpoint("api/hello"))
        request.httpMethod = "GET"
        _ = try await data(for: request)
    }

    func assetIsCurrent(assetFolder: String, fingerprint: String) async throws -> Bool {
        let response: AssetStatusResponse = try await postJSON(
            AssetStatusRequest(assetFolder: assetFolder, fingerprint: fingerprint),
            to: endpoint("api/asset/status")
        )
        return response.complete
    }

    func uploadResource(
        fileURL: URL,
        relativePath: String,
        byteCount: Int64,
        progress: @escaping @Sendable (_ uploadedBytes: Int64) -> Void
    ) async throws {
        let status: ResourceStatusResponse = try await postJSON(
            ResourceStatusRequest(relativePath: relativePath, byteCount: byteCount),
            to: endpoint("api/resource/status")
        )

        if status.complete {
            progress(byteCount)
            return
        }

        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }

        var offset = max(0, min(status.offset, byteCount))
        progress(offset)

        while offset < byteCount {
            try Task.checkCancellation()
            try handle.seek(toOffset: UInt64(offset))
            let remaining = byteCount - offset
            let chunkSize = Int(min(2 * 1024 * 1024, remaining))
            guard let chunk = try handle.read(upToCount: chunkSize), !chunk.isEmpty else {
                throw URLError(.cannotDecodeContentData)
            }

            var components = URLComponents(url: endpoint("api/resource"), resolvingAgainstBaseURL: false)!
            components.queryItems = [
                URLQueryItem(name: "relativePath", value: relativePath),
                URLQueryItem(name: "offset", value: String(offset))
            ]

            var request = URLRequest(url: components.url!)
            request.httpMethod = "PUT"
            request.setValue(String(byteCount), forHTTPHeaderField: "X-Expected-Bytes")
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            request.httpBody = chunk

            let response: ResourceUploadResponse = try await decoded(for: request)
            if response.retry == true {
                offset = max(0, min(response.offset, byteCount))
                progress(offset)
                continue
            }

            guard response.offset > offset || response.complete else {
                throw URLError(.cannotWriteToFile)
            }
            offset = max(0, min(response.offset, byteCount))
            progress(offset)
        }
    }

    func commitAsset(sidecar: AssetSidecar, event: BackupEvent, assetFolder: String) async throws {
        let response: BasicResponse = try await postJSON(
            AssetCommitRequest(assetFolder: assetFolder, sidecar: sidecar, event: event),
            to: endpoint("api/asset/commit")
        )
        if response.ok == false {
            throw URLError(.badServerResponse)
        }
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    private func endpoint(_ path: String) -> URL {
        device.baseURL.appendingPathComponent(path)
    }

    private func postJSON<Request: Encodable, Response: Decodable>(_ value: Request, to url: URL) async throws -> Response {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encode(value)
        return try await decoded(for: request)
    }

    private func decoded<Response: Decodable>(for request: URLRequest) async throws -> Response {
        let data = try await data(for: request)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(Response.self, from: data)
    }

    private func data(for request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return data
    }

    private func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(value)
    }
}
