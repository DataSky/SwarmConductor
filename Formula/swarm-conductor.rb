# Formula/swarm-conductor.rb
#
# 安装方式：
#   brew tap DataSky/swarm-conductor https://github.com/DataSky/SwarmConductor
#   brew install swarm-conductor

class SwarmConductor < Formula
  desc "Multi-agent orchestration layer for CodeWhale — run 10+ AI coding agents in parallel"
  homepage "https://github.com/DataSky/SwarmConductor"
  version "0.1.4"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/DataSky/SwarmConductor/releases/download/v#{version}/swarm-conductor-#{version}-darwin-arm64.tar.gz"
      # sha256 will be updated by CI after each release
      sha256 "85b33a4159050846fc8926fa4282ac5de2459f7a015f8248368673dec82274c6"
    end

    on_intel do
      url "https://github.com/DataSky/SwarmConductor/releases/download/v#{version}/swarm-conductor-#{version}-darwin-x64.tar.gz"
      sha256 "30b080c46ee6abb7763c1c5f499fc465bdccc3fed5e4a74155c2d5acbdebfa8d"
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
