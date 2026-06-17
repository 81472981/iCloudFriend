import Foundation
import Darwin

final class ReceiverDiscovery: NSObject, ObservableObject {
    @Published private(set) var devices: [ReceiverDevice] = []
    @Published private(set) var isScanning = false
    @Published var selectedDevice: ReceiverDevice?

    private let browser = NetServiceBrowser()
    private var services: [NetService] = []
    private var fallbackScanTask: Task<Void, Never>?

    private static let fallbackDiscoveryPort = 52119

    override init() {
        super.init()
        browser.delegate = self
    }

    func start() {
        guard !isScanning else { return }
        devices = []
        services = []
        selectedDevice = nil
        isScanning = true
        browser.searchForServices(ofType: "_icloudfriend._tcp.", inDomain: "local.")
        startFallbackScan()
    }

    func stop() {
        fallbackScanTask?.cancel()
        fallbackScanTask = nil
        browser.stop()
        services.forEach { $0.stop() }
        services = []
        isScanning = false
    }

    func refresh() {
        stop()
        start()
    }

    func select(_ device: ReceiverDevice) {
        if !devices.contains(where: { $0.id == device.id }) {
            devices.append(device)
        }
        selectedDevice = device
    }

    func manualDevice(from value: String) throws -> ReceiverDevice {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = text.contains("://") ? text : "http://\(text)"
        guard let components = URLComponents(string: normalized),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              let host = components.host,
              let port = components.port,
              port > 0 else {
            throw ReceiverDiscoveryError.invalidManualAddress
        }

        return ReceiverDevice(
            id: "manual-\(scheme)-\(host)-\(port)",
            name: "iCloudFriend \(host)",
            scheme: scheme,
            hostName: host,
            port: port,
            fingerprint: nil,
            protocolVersion: 1
        )
    }

    private func startFallbackScan() {
        fallbackScanTask?.cancel()
        let hosts = Self.fallbackDiscoveryHosts()
        guard !hosts.isEmpty else { return }

        fallbackScanTask = Task { [weak self] in
            await self?.scanFallbackHosts(hosts)
        }
    }

    private func scanFallbackHosts(_ hosts: [String]) async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 0.7
        configuration.timeoutIntervalForResource = 0.7
        configuration.waitsForConnectivity = false
        let session = URLSession(configuration: configuration)
        let concurrency = min(32, max(1, hosts.count))
        var iterator = hosts.makeIterator()

        await withTaskGroup(of: ReceiverDevice?.self) { group in
            for _ in 0..<concurrency {
                guard let host = iterator.next() else { break }
                group.addTask {
                    await Self.probeFallbackHost(host, session: session)
                }
            }

            while let device = await group.next() {
                if Task.isCancelled {
                    group.cancelAll()
                    break
                }

                if let device {
                    await MainActor.run {
                        self.upsertDiscoveredDevice(device)
                    }
                }

                if let host = iterator.next() {
                    group.addTask {
                        await Self.probeFallbackHost(host, session: session)
                    }
                }
            }
        }

        await MainActor.run {
            if self.devices.isEmpty {
                self.isScanning = false
            }
        }
    }

    @MainActor
    private func upsertDiscoveredDevice(_ device: ReceiverDevice) {
        if let index = devices.firstIndex(where: { $0.id == device.id }) {
            devices[index] = device
        } else if !devices.contains(where: { $0.hostName == device.hostName && $0.port == device.port }) {
            devices.append(device)
        }

        if selectedDevice?.id == device.id {
            selectedDevice = device
        }
    }

    private static func probeFallbackHost(_ host: String, session: URLSession) async -> ReceiverDevice? {
        guard let url = URL(string: "http://\(host):\(fallbackDiscoveryPort)/api/hello") else {
            return nil
        }

        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                return nil
            }

            let hello = try JSONDecoder().decode(ReceiverHelloResponse.self, from: data)
            guard hello.app == "iCloudFriend",
                  hello.receiver?.running != false else {
                return nil
            }

            let receiver = hello.receiver
            let port = receiver?.httpPort ?? fallbackDiscoveryPort
            let name = receiver?.serviceName ?? "iCloudFriend \(hello.hostname ?? host)"
            return ReceiverDevice(
                id: "fallback-\(host)-\(port)",
                name: name,
                scheme: "http",
                hostName: host,
                port: port,
                fingerprint: receiver?.fingerprint,
                protocolVersion: receiver?.protocolVersion ?? hello.protocolVersion ?? 1
            )
        } catch {
            return nil
        }
    }

    private static func fallbackDiscoveryHosts() -> [String] {
        var hosts: [String] = []

        #if targetEnvironment(simulator)
        hosts.append("127.0.0.1")
        #endif

        for network in localIPv4Networks() {
            hosts.append(contentsOf: hostsToScan(for: network))
        }

        var seen = Set<String>()
        return hosts.filter { host in
            guard !seen.contains(host) else { return false }
            seen.insert(host)
            return true
        }
    }

    private static func localIPv4Networks() -> [IPv4Network] {
        var pointer: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&pointer) == 0, let first = pointer else {
            return []
        }
        defer { freeifaddrs(pointer) }

        var networks: [IPv4Network] = []
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let current = cursor {
            defer { cursor = current.pointee.ifa_next }
            let flags = current.pointee.ifa_flags
            guard (flags & UInt32(IFF_UP)) != 0,
                  (flags & UInt32(IFF_LOOPBACK)) == 0,
                  let addressPointer = current.pointee.ifa_addr,
                  let netmaskPointer = current.pointee.ifa_netmask,
                  Int32(addressPointer.pointee.sa_family) == AF_INET,
                  let address = ipv4AddressString(addressPointer),
                  let netmask = ipv4AddressString(netmaskPointer),
                  let addressValue = ipv4Number(address),
                  let netmaskValue = ipv4Number(netmask) else {
                continue
            }

            networks.append(IPv4Network(address: addressValue, netmask: netmaskValue))
        }

        return networks
    }

    private static func hostsToScan(for network: IPv4Network) -> [String] {
        let networkAddress = network.address & network.netmask
        let broadcastAddress = networkAddress | ~network.netmask
        let hostCount = broadcastAddress > networkAddress ? broadcastAddress - networkAddress - 1 : 0

        let start: UInt32
        let end: UInt32
        if hostCount > 0 && hostCount <= 512 {
            start = networkAddress + 1
            end = broadcastAddress - 1
        } else {
            let localClassC = network.address & 0xFF_FF_FF_00
            start = localClassC + 1
            end = localClassC + 254
        }

        guard start <= end else { return [] }
        return (start...end).compactMap(ipv4String)
    }

    private static func ipv4AddressString(_ pointer: UnsafePointer<sockaddr>) -> String? {
        var address = pointer.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
            $0.pointee.sin_addr
        }
        var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        guard inet_ntop(AF_INET, &address, &buffer, socklen_t(INET_ADDRSTRLEN)) != nil else {
            return nil
        }
        return String(cString: buffer)
    }

    private static func ipv4Number(_ address: String) -> UInt32? {
        let parts = address.split(separator: ".").compactMap { UInt32($0) }
        guard parts.count == 4, parts.allSatisfy({ $0 <= 255 }) else {
            return nil
        }
        return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]
    }

    private static func ipv4String(_ value: UInt32) -> String {
        [
            (value >> 24) & 0xFF,
            (value >> 16) & 0xFF,
            (value >> 8) & 0xFF,
            value & 0xFF
        ].map(String.init).joined(separator: ".")
    }
}

private struct ReceiverHelloResponse: Decodable {
    let app: String
    let hostname: String?
    let protocolVersion: Int?
    let receiver: ReceiverHelloStatus?
}

private struct ReceiverHelloStatus: Decodable {
    let running: Bool?
    let serviceName: String?
    let fingerprint: String?
    let httpPort: Int?
    let protocolVersion: Int?
}

private struct IPv4Network {
    let address: UInt32
    let netmask: UInt32
}

enum ReceiverDiscoveryError: LocalizedError {
    case invalidManualAddress

    var errorDescription: String? {
        switch self {
        case .invalidManualAddress:
            return "请输入 Windows 端显示的连接地址，例如 http://192.168.1.10:50000。"
        }
    }
}

extension ReceiverDiscovery: NetServiceBrowserDelegate {
    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        services.append(service)
        service.delegate = self
        service.resolve(withTimeout: 5)
    }

    func netServiceBrowserDidStopSearch(_ browser: NetServiceBrowser) {
        DispatchQueue.main.async {
            self.isScanning = false
        }
    }
}

extension ReceiverDiscovery: NetServiceDelegate {
    func netServiceDidResolveAddress(_ sender: NetService) {
        guard let hostName = sender.hostName, sender.port > 0 else { return }

        let txt = decodeTXT(sender.txtRecordData())
        let version = Int(txt["version"] ?? "") ?? 1
        let fingerprint = txt["fingerprint"]
        let device = ReceiverDevice(
            id: "\(sender.name)-\(hostName)-\(sender.port)",
            name: sender.name,
            scheme: "https",
            hostName: hostName,
            port: sender.port,
            fingerprint: fingerprint,
            protocolVersion: version
        )

        DispatchQueue.main.async {
            if let index = self.devices.firstIndex(where: { $0.id == device.id }) {
                self.devices[index] = device
            } else {
                self.devices.append(device)
            }

            if self.selectedDevice?.id == device.id {
                self.selectedDevice = device
            }
        }
    }

    private func decodeTXT(_ data: Data?) -> [String: String] {
        guard let data else { return [:] }
        let raw = NetService.dictionary(fromTXTRecord: data)
        return raw.reduce(into: [String: String]()) { result, item in
            result[item.key] = String(data: item.value, encoding: .utf8)
        }
    }
}
