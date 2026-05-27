# Formula/swarm-conductor.rb
#
# 安装方式：
#   brew tap DataSky/swarm-conductor https://github.com/DataSky/SwarmConductor
#   brew install swarm-conductor

class SwarmConductor < Formula
  desc "Multi-agent orchestration layer for CodeWhale — run 10+ AI coding agents in parallel"
  homepage "https://github.com/DataSky/SwarmConductor"
  version "0.2.3"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/DataSky/SwarmConductor/releases/download/v#{version}/swarm-conductor-#{version}-darwin-arm64.tar.gz"
      # sha256 will be updated by CI after each release
      sha256 "7c9b8f6e1f2653fb67565ce26660dcd78acfc734b60612b791daa3c9f95d2d1a"
    end

    on_intel do
      url "https://github.com/DataSky/SwarmConductor/releases/download/v#{version}/swarm-conductor-#{version}-darwin-x64.tar.gz"
      sha256 "3ecc70471fa624e2a691dc34e53656514adaa9505fdcfcfa45852ba793b0a54a"
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
