# Formula/swarm-conductor.rb
#
# 安装方式：
#   brew tap DataSky/swarm-conductor https://github.com/DataSky/SwarmConductor
#   brew install swarm-conductor

class SwarmConductor < Formula
  desc "Multi-agent orchestration layer for CodeWhale — run 10+ AI coding agents in parallel"
  homepage "https://github.com/DataSky/SwarmConductor"
  version "0.1.5"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/DataSky/SwarmConductor/releases/download/v#{version}/swarm-conductor-#{version}-darwin-arm64.tar.gz"
      # sha256 will be updated by CI after each release
      sha256 "ee60d969654c4a9613aa543ff0f7eefecb0fa5be4fad5908afcdd6b8b8400420"
    end

    on_intel do
      url "https://github.com/DataSky/SwarmConductor/releases/download/v#{version}/swarm-conductor-#{version}-darwin-x64.tar.gz"
      sha256 "02c0a0093d22c52d2d475c614a8c7becf1e6d867d501d64ee1c7090f17be2a19"
    end
  end

  def install
    bin.install "swarm-conductor"
    bin.install_symlink "swarm-conductor" => "swarm"
  end

  def caveats
    <<~EOS
      swarm-conductor requires CodeWhale CLI to spawn agent workers:
        npm install -g codewhale

      Quick start:
        swarm run --goal "分析项目结构" --project /path/to/your/project --auto-approve
        swarm run --tasks example-tasks.yaml --auto-approve
        swarm demo

      Full docs: https://github.com/DataSky/SwarmConductor/tree/main/docs

      ── macOS Security Notice ──────────────────────────────────────────
      This binary is not yet signed with an Apple Developer certificate.
      If macOS blocks it on first launch, run ONE of the following:

        Option 1 (GUI):
          System Settings -> Privacy & Security -> Allow Anyway

        Option 2 (terminal):
          xattr -d com.apple.quarantine $(which swarm)

      This only needs to be done once.
      ──────────────────────────────────────────────────────────────────
    EOS
  end

  test do
    output = shell_output("#{bin}/swarm-conductor demo 2>&1")
    assert_match "Task DAG", output
    assert_match "Deadlock check", output
  end
end
