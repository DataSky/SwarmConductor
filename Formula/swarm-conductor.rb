# Formula/swarm-conductor.rb
#
# 安装方式：
#   brew tap DataSky/swarm-conductor https://github.com/DataSky/SwarmConductor
#   brew install swarm-conductor

class SwarmConductor < Formula
  desc "Multi-agent orchestration layer for CodeWhale — run 10+ AI coding agents in parallel"
  homepage "https://github.com/DataSky/SwarmConductor"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/DataSky/SwarmConductor/releases/download/v#{version}/swarm-conductor-#{version}-darwin-arm64.tar.gz"
      # sha256 will be updated by CI after each release
      sha256 "27419ea9437a1ab46f54cc916558cfa601a5f75e518dad4a9fcb5d8fccd9ef0a"
    end

    on_intel do
      url "https://github.com/DataSky/SwarmConductor/releases/download/v#{version}/swarm-conductor-#{version}-darwin-x64.tar.gz"
      sha256 "b545fe4d51ae9cbf55b56cb3ff38548c5fd37619224d1f64599adeb1585c6790"
    end
  end

  def install
    if Hardware::CPU.arm?
      bin.install "swarm-conductor-darwin-arm64" => "swarm-conductor"
    else
      bin.install "swarm-conductor-darwin-x64" => "swarm-conductor"
    end
  end

  def caveats
    <<~EOS
      swarm-conductor requires CodeWhale CLI to spawn agent workers:
        npm install -g codewhale

      Quick start:
        swarm-conductor demo
        swarm-conductor run --project /path/to/your/project --agents 5 --auto-approve

      Full docs: https://github.com/DataSky/SwarmConductor/tree/main/docs
    EOS
  end

  test do
    output = shell_output("#{bin}/swarm-conductor demo 2>&1")
    assert_match "Task DAG", output
    assert_match "Deadlock check", output
  end
end
