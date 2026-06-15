import SwiftUI

struct ProgressRing: View {
    let value: Double
    let title: String
    let subtitle: String

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.white.opacity(0.22), lineWidth: 16)
            Circle()
                .trim(from: 0, to: min(max(value, 0), 1))
                .stroke(
                    AngularGradient(
                        colors: [Color.cyan, Color.blue, Color.green],
                        center: .center
                    ),
                    style: StrokeStyle(lineWidth: 16, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
                .animation(.spring(response: 0.6, dampingFraction: 0.85), value: value)

            VStack(spacing: 6) {
                Text("\(Int(value * 100))%")
                    .font(.system(size: 42, weight: .bold, design: .rounded))
                    .monospacedDigit()
                Text(title)
                    .font(.headline)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
            .padding(28)
        }
        .frame(width: 230, height: 230)
    }
}
