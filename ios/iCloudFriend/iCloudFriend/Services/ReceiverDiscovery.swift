import Foundation

final class ReceiverDiscovery: NSObject, ObservableObject {
    @Published private(set) var devices: [ReceiverDevice] = []
    @Published private(set) var isScanning = false
    @Published var selectedDevice: ReceiverDevice?

    private let browser = NetServiceBrowser()
    private var services: [NetService] = []

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
    }

    func stop() {
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
        let normalized = text.contains("://") ? text : "https://\(text)"
        guard let components = URLComponents(string: normalized),
              components.scheme == "https",
              let host = components.host,
              let port = components.port,
              port > 0 else {
            throw ReceiverDiscoveryError.invalidManualAddress
        }

        return ReceiverDevice(
            id: "manual-\(host)-\(port)",
            name: "iCloudFriend \(host)",
            hostName: host,
            port: port,
            fingerprint: nil,
            protocolVersion: 1
        )
    }
}

enum ReceiverDiscoveryError: LocalizedError {
    case invalidManualAddress

    var errorDescription: String? {
        switch self {
        case .invalidManualAddress:
            return "请输入 Windows 端显示的 https 地址，例如 https://192.168.1.10:50000。"
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
