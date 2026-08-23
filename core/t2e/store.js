/**
 * Transfer2Eval 状态存储
 * 将 episodes / tasks / 数据集产物持久化到 agent-backup/transfer2eval/ 目录
 * 采用 JSON 文件存储（单文件 + 索引），不依赖外部数据库
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 默认存储根目录（与 AI-Exporter 备份目录同根） */
export const DEFAULT_ROOT = path.resolve(__dirname, '../../agent-backup/transfer2eval');

class T2EStore {
  constructor(root = process.env.T2E_STORE || DEFAULT_ROOT) {
    this.root = root;
    this.episodesDir = path.join(root, 'episodes');
    this.tasksDir = path.join(root, 'tasks');
    this.datasetsDir = path.join(root, 'datasets');
    this.metaFile = path.join(root, 'meta.json');
    this._ensureDirs();
    this._ensureMeta();
  }

  _ensureDirs() {
    for (const dir of [this.root, this.episodesDir, this.tasksDir, this.datasetsDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _ensureMeta() {
    if (!fs.existsSync(this.metaFile)) {
      fs.writeFileSync(this.metaFile, JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        counts: { episodes: 0, tasks: 0, exported: 0 },
      }, null, 2));
    }
  }

  _readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  _writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  _episodeFile(id) {
    return path.join(this.episodesDir, `${id}.json`);
  }

  _taskFile(id) {
    return path.join(this.tasksDir, `${id}.json`);
  }

  _updateMeta(delta = {}) {
    // 只做目录级计数（readdir），避免每次保存都全量反序列化所有文件（O(n) → O(dirs)）
    const meta = this._readJson(this.metaFile) || {};
    meta.updatedAt = new Date().toISOString();
    const prev = meta.counts || { episodes: 0, tasks: 0, exported: 0 };
    meta.counts = {
      episodes: this._countFiles(this.episodesDir),
      tasks: this._countFiles(this.tasksDir),
      exported: delta.exported ?? prev.exported,
    };
    this._writeJson(this.metaFile, { ...meta, ...delta });
    return meta;
  }

  _countFiles(dir) {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }

  // ---------- Episodes ----------
  saveEpisode(episode) {
    episode.updatedAt = new Date().toISOString();
    this._writeJson(this._episodeFile(episode.id), episode);
    this._updateMeta();
    return episode;
  }

  getEpisode(id) {
    return this._readJson(this._episodeFile(id));
  }

  listEpisodes(filter = {}) {
    const all = fs.readdirSync(this.episodesDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this._readJson(path.join(this.episodesDir, f)))
      .filter(Boolean);
    if (filter.status) return all.filter((e) => e.status === filter.status);
    if (filter.source) return all.filter((e) => e.source === filter.source);
    return all;
  }

  deleteEpisode(id) {
    const file = this._episodeFile(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    this._updateMeta();
  }

  // ---------- Tasks ----------
  saveTask(task) {
    this._writeJson(this._taskFile(task.id), task);
    this._updateMeta();
    return task;
  }

  getTask(id) {
    return this._readJson(this._taskFile(id));
  }

  listTasks(filter = {}) {
    const all = fs.readdirSync(this.tasksDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this._readJson(path.join(this.tasksDir, f)))
      .filter(Boolean);
    if (filter.status) return all.filter((t) => t.status === filter.status);
    if (filter.episodeId) return all.filter((t) => t.episodeId === filter.episodeId);
    return all;
  }

  deleteTask(id) {
    const file = this._taskFile(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    this._updateMeta();
  }

  // ---------- Datasets ----------
  saveDataset(name, data) {
    const file = path.join(this.datasetsDir, name);
    this._writeJson(file, data);
    this._updateMeta();
    return file;
  }

  getDataset(name) {
    return this._readJson(path.join(this.datasetsDir, name));
  }

  listDatasets() {
    return fs.readdirSync(this.datasetsDir).filter((f) => f.endsWith('.json'));
  }

  // ---------- 统计 ----------
  stats() {
    const episodes = this.listEpisodes();
    const tasks = this.listTasks();
    const byStatus = {};
    for (const e of episodes) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    const bySource = {};
    for (const e of episodes) bySource[e.source] = (bySource[e.source] || 0) + 1;
    return {
      root: this.root,
      episodes: episodes.length,
      tasks: tasks.length,
      byStatus,
      bySource,
      updatedAt: new Date().toISOString(),
    };
  }
}

export const store = new T2EStore();
export default T2EStore;
