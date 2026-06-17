import SwiftUI

struct ContentView: View {
    @ObservedObject var receiverDiscovery: ReceiverDiscovery
    @ObservedObject var backupManager: BackupManager

    @State private var selectedMode: BackupMode = .incremental
    @State private var manualAddress = ""
    @State private var manualAddressError: String?
    @State private var isManualConnecting = false
    @State private var connectingDeviceID: String?

    private let orange = Color(red: 1.0, green: 0.58, blue: 0.08)
    private let red = Color(red: 1.0, green: 0.22, blue: 0.20)
    private let green = Color(red: 0.0, green: 0.68, blue: 0.12)

    var body: some View {
        ZStack {
            if receiverDiscovery.selectedDevice == nil {
                searchScreen
                    .transition(.opacity)
            } else {
                syncScreen
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.18), value: receiverDiscovery.selectedDevice)
    }

    private var searchScreen: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 1.0, green: 0.70, blue: 0.18), orange, Color(red: 0.96, green: 0.35, blue: 0.05)],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 22) {
                VStack(spacing: 8) {
                    Text("自动搜索你的电脑")
                        .font(.system(size: 28, weight: .semibold, design: .rounded))
                    Text("打开 Windows 程序后会自动出现")
                        .font(.subheadline)
                }
                .foregroundStyle(.white)
                .padding(.top, 36)

                VStack(spacing: 0) {
                    HStack {
                        Text("可连接电脑")
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        if receiverDiscovery.isScanning {
                            ProgressView()
                                .scaleEffect(0.75)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)

                    Divider()

                    if receiverDiscovery.devices.isEmpty {
                        emptySearchState
                    } else {
                        ForEach(receiverDiscovery.devices) { device in
                            Button {
                                connect(device)
                            } label: {
                                deviceRow(device)
                            }
                            .buttonStyle(.plain)
                            .disabled(connectingDeviceID != nil || isManualConnecting)

                            if device.id != receiverDiscovery.devices.last?.id {
                                Divider().padding(.leading, 68)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 220, alignment: .top)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 8, style: .continuous))

                manualAddressBox

                Spacer()

                Button {
                    if receiverDiscovery.isScanning {
                        receiverDiscovery.stop()
                    } else {
                        receiverDiscovery.refresh()
                    }
                } label: {
                    Text(receiverDiscovery.isScanning ? "停止搜索" : "重新搜索电脑")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .foregroundStyle(.white)
                .background(red, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 26)
        }
    }

    private var manualAddressBox: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("手动连接")
                .font(.subheadline.weight(.semibold))

            HStack(spacing: 10) {
                TextField("https://电脑地址:端口", text: $manualAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .font(.subheadline)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 11)
                    .background(Color.white.opacity(0.92), in: RoundedRectangle(cornerRadius: 8, style: .continuous))

                Button(isManualConnecting ? "连接中" : "连接") {
                    connectManualAddress()
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(red, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .disabled(isManualConnecting)
            }

            if let manualAddressError {
                Text(manualAddressError)
                    .font(.caption)
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .background(Color.white.opacity(0.16), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func connect(_ device: ReceiverDevice) {
        guard connectingDeviceID == nil, !isManualConnecting else { return }
        connectingDeviceID = device.id
        manualAddressError = nil

        Task {
            do {
                try await ReceiverClient(device: device).hello()
                await MainActor.run {
                    receiverDiscovery.select(device)
                    connectingDeviceID = nil
                    manualAddressError = nil
                }
            } catch {
                await MainActor.run {
                    manualAddressError = connectionMessage(for: error)
                    connectingDeviceID = nil
                }
            }
        }
    }

    private func connectManualAddress() {
        guard !isManualConnecting else { return }
        isManualConnecting = true
        manualAddressError = nil

        Task {
            do {
                let device = try receiverDiscovery.manualDevice(from: manualAddress)
                try await ReceiverClient(device: device).hello()
                await MainActor.run {
                    receiverDiscovery.select(device)
                    manualAddressError = nil
                    isManualConnecting = false
                }
            } catch {
                await MainActor.run {
                    manualAddressError = connectionMessage(for: error)
                    isManualConnecting = false
                }
            }
        }
    }

    private var emptySearchState: some View {
        VStack(spacing: 12) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 38, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(receiverDiscovery.isScanning ? "正在搜索同一 Wi-Fi 下的电脑" : "没有发现电脑")
                .font(.headline)
            Text("请保持 Windows 程序打开，并让手机与电脑连接同一网络。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)
        }
        .frame(maxWidth: .infinity, minHeight: 180)
    }

    private func deviceRow(_ device: ReceiverDevice) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 32, weight: .medium))
                .foregroundStyle(.blue)
                .frame(width: 40)

            VStack(alignment: .leading, spacing: 3) {
                Text(device.displayName)
                    .font(.system(.body, design: .rounded).weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(device.hostName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            if connectingDeviceID == device.id {
                ProgressView()
                    .scaleEffect(0.75)
            } else {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    private var syncScreen: some View {
        ZStack {
            LinearGradient(
                colors: [Color.black, Color(red: 0.08, green: 0.10, blue: 0.11), Color(red: 0.02, green: 0.06, blue: 0.07)],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                HStack {
                    Spacer()
                    Button {
                        if !backupManager.isRunning {
                            receiverDiscovery.selectedDevice = nil
                            receiverDiscovery.refresh()
                        }
                    } label: {
                        Image(systemName: "square.grid.2x2")
                            .font(.system(size: 18, weight: .semibold))
                            .padding(10)
                    }
                    .foregroundStyle(.white.opacity(0.8))
                    .disabled(backupManager.isRunning)
                }
                .padding(.top, 18)

                connectedHeader

                Spacer()

                progressSummary

                Spacer()

                VStack(spacing: 14) {
                    Picker("同步模式", selection: $selectedMode) {
                        Text("增量").tag(BackupMode.incremental)
                        Text("全量").tag(BackupMode.full)
                    }
                    .pickerStyle(.segmented)
                    .disabled(backupManager.isRunning)

                    Text("照片、视频和 Live Photo 将同步到你的 Windows 电脑。")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.68))
                        .frame(maxWidth: .infinity, alignment: .leading)

                    mainActionButton
                }
                .padding(.bottom, 26)
            }
            .padding(.horizontal, 20)
        }
    }

    private var connectedHeader: some View {
        VStack(spacing: 5) {
            Text("已连接")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.green)

            Text(receiverDiscovery.selectedDevice?.displayName ?? "Windows 电脑")
                .font(.system(size: 20, weight: .semibold, design: .rounded))
                .foregroundStyle(orange)
                .lineLimit(1)

            Text(receiverDiscovery.selectedDevice?.hostName ?? "")
                .font(.caption)
                .foregroundStyle(.white.opacity(0.45))
                .lineLimit(1)
        }
        .padding(.top, 10)
    }

    private var progressSummary: some View {
        VStack(spacing: 12) {
            Text("\(backupManager.progress.completedAssets)")
                .font(.system(size: 58, weight: .medium, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(red)

            Text(totalText)
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.62))

            ProgressView(value: backupManager.progress.assetFraction)
                .tint(red)
                .frame(maxWidth: 220)

            Text(statusText)
                .font(.caption)
                .foregroundStyle(.white.opacity(0.55))
                .lineLimit(1)
        }
    }

    private var mainActionButton: some View {
        Button {
            if backupManager.isRunning {
                backupManager.cancel()
            } else {
                backupManager.start(mode: selectedMode)
            }
        } label: {
            Label(backupManager.isRunning ? "停止同步照片" : "开始同步照片", systemImage: backupManager.isRunning ? "stop.fill" : "play.fill")
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
        }
        .foregroundStyle(.white)
        .background(backupManager.isRunning ? red : green, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var totalText: String {
        let total = backupManager.progress.totalAssets
        guard total > 0 else {
            return "已同步 \(backupManager.progress.completedAssets) 张"
        }
        return "已同步 \(backupManager.progress.completedAssets) / \(total) 张"
    }

    private var statusText: String {
        if case .failed(let message) = backupManager.progress.status {
            return message
        }
        if !backupManager.progress.currentAssetName.isEmpty {
            return backupManager.progress.currentAssetName
        }
        switch backupManager.progress.status {
        case .idle:
            return "准备开始同步"
        case .preparing:
            return "正在准备照片"
        case .running:
            return "正在同步"
        case .finished:
            return "同步完成"
        case .cancelled:
            return "已取消"
        case .failed:
            return "同步失败"
        }
    }

    private func connectionMessage(for error: Error) -> String {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            switch URLError.Code(rawValue: nsError.code) {
            case .secureConnectionFailed,
                 .serverCertificateUntrusted,
                 .serverCertificateHasBadDate,
                 .serverCertificateHasUnknownRoot,
                 .serverCertificateNotYetValid:
                return "TLS 连接失败，请在 Windows 端复制最新连接地址后重试。"
            case .cannotConnectToHost, .cannotFindHost, .timedOut, .networkConnectionLost, .notConnectedToInternet:
                return "无法连接 Windows 端，请确认两端在同一网络且 Windows 程序已打开。"
            default:
                break
            }
        }
        return error.localizedDescription
    }
}

#Preview {
    let discovery = ReceiverDiscovery()
    return ContentView(receiverDiscovery: discovery, backupManager: BackupManager(receiverDiscovery: discovery))
}
