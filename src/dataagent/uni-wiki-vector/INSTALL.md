# INSTALL · uni-wiki-vector 安装与部署指南

> **版本**：v5.2 | 适用环境：DataSky内部 DataAgent 沙箱（datasky.internal）

---

## 一、系统要求

| 组件 | 要求 |
|------|------|
| Python | **≥ 3.8**（纯标准库，无需任何 pip 包） |
| 磁盘空间 | **≥ 30 MB**（wiki 内容 6.2MB + BM25 索引 9.4MB + 脚本） |
| 运行环境 | DataAgent 沙箱（Linux，已预装 Python 3） |
| 外部依赖 | **无**（v5.0 已移除 Milvus/onnxruntime/transformers） |

---

## 二、全新安装（首次部署）

### 步骤 1：确认沙箱目录

```bash
# 确认 User Skills 目录存在
ls /data_agent/users/assets/user_skills/
```

### 步骤 2：解压安装包（如从 zip 迁移）

```bash
# 将 uni-wiki-vector.zip 上传到沙箱后执行：
cd /data_agent/users/assets/user_skills/
unzip uni-wiki-vector.zip -d uni-wiki-vector/
# 如果解压到了子目录，调整路径即可
```

### 步骤 3：验证安装

```bash
# 进入检索目录
cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki

# 验证 wiki 页面数量
find wiki -name "*.md" | wc -l
# 预期输出：1438

# 验证 BM25 索引存在
ls -lh .bm25_index.json
# 预期输出：-rw-r--r-- ... 9.4M ... .bm25_index.json

# 验证脚本可运行（快速检索测试）
python3 search.py --queries "直播GMV" --top 3 --list
# 预期输出：3个 wiki 文件路径
```

---

## 三、DataAgent Skill 注册（沙箱已存在时跳过）

uni-wiki-vector 是 User Skill，存放在固定路径时 DataAgent 会自动识别：

```
/data_agent/users/assets/user_skills/uni-wiki-vector/
```

**目录结构必须包含 `SKILL.md`**（DataAgent 通过此文件识别 Skill）。

验证注册状态：
```bash
cat /data_agent/users/assets/user_skills/uni-wiki-vector/SKILL.md | head -5
# 预期输出：Skill 名称和 description
```

---

## 四、BM25 索引状态检查

### 4.1 索引已存在时（正常情况）

```bash
cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki
ls -lh .bm25_index.json
# 显示文件存在且大小约 9-10MB，则无需任何操作
```

### 4.2 索引不存在时（首次运行或损坏时）

```bash
cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki

# 重建 BM25 索引（约 1-2 秒）
python3 search.py --rebuild

# 输出示例：
# [INFO] 重建 BM25 索引...
# [INFO] 加载 1438 个页面
# [INFO] 索引写入 .bm25_index.json
# [INFO] 完成
```

---

## 五、从旧版本升级

### 5.1 从 v4.x（含 Hybrid 向量检索）升级到 v5.x

v5.0 已移除 Hybrid 模块，升级后以下组件不再使用：

| 组件 | 状态 | 说明 |
|------|------|------|
| `hybrid_model/` 目录 | 可保留（不影响运行）| ONNX 模型文件，不再加载 |
| `.hybrid_mean.npy` | 可删除 | 旧向量索引，不再使用 |
| `pymilvus` pip 包 | 无需安装 | v5.0 已不依赖 |

```bash
# （可选）清理旧的向量相关文件
cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki
rm -f .hybrid_mean.npy

# 重建 BM25 索引
python3 search.py --rebuild
```

### 5.2 从 v5.1 升级到 v5.2（新增 mp 域 + cross_domain）

```bash
# 如果是增量更新，只需重建索引
cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki
python3 search.py --rebuild

# 验证 mp 域已加入
python3 search.py --queries "广告消耗 厘" --top 3 --list
# 预期出现 wiki/rules/mp/ 路径
```

---

## 六、迁移到其他沙箱 / 账号

由于沙箱按用户隔离，迁移时需重新部署。

### 方法 A：从 zip 包迁移（推荐）

1. 从当前沙箱下载 `uni-wiki-vector.zip`（见 README 下载链接）
2. 在目标沙箱上传 zip 文件
3. 解压到 `/data_agent/users/assets/user_skills/` 目录
4. 执行验证步骤（见第二节步骤3）

### 方法 B：Git 同步（如有版本管理）

```bash
# 将 uni-wiki/ 目录同步到目标沙箱
# （需配置相应的 Git 访问权限）
```

---

## 七、常见安装问题

### Q：`python3 search.py` 报 `ModuleNotFoundError`

v5.x 纯标准库，不需要任何 pip 包。如遇此错误，确认 Python 版本 ≥ 3.8：
```bash
python3 --version
```

### Q：`find wiki -name "*.md" | wc -l` 输出不是 1438

wiki 页面数量不对，可能是解压不完整。检查：
```bash
du -sh /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki/wiki/
# 预期约 6-7 MB
```

### Q：首次运行很慢（>10s）

v5.x 首次调用约 5s（加载 1438 页面 + 解析索引），属正常。热态后响应 <1s。
如果超过 30s，可能是磁盘 IO 较慢，等待即可。

### Q：`.bm25_index.json` 丢失

沙箱重启后持久化文件应保留。如丢失，执行 `python3 search.py --rebuild` 重建（~1-2s）。

---

## 八、卸载

```bash
# 删除整个 Skill 目录（不可恢复，谨慎操作）
rm -rf /data_agent/users/assets/user_skills/uni-wiki-vector/
```

---

## 九、性能参考

| 场景 | 耗时 | 说明 |
|------|------|------|
| 首次调用（冷启动） | ~5s | 加载 1438 页面 + BM25 索引 |
| 后续调用（热态） | <1s | 内存缓存命中 |
| 重建索引（--rebuild） | ~1-2s | 读取所有 .md 文件 + 写 JSON |
| gap-check（10个章节） | ~3-5s | 含批量 BM25 检索 |

---

*最后更新：2026-06-05 10:04 | DataAgent wangteng06*
