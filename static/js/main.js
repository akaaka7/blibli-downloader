// 下载功能相关的常量
const API_BASE_URL = 'http://localhost:8000/api';
const WS_BASE_URL = 'ws://localhost:8000/ws';

// 下载状态枚举
const DownloadStatus = {
    WAITING: 'waiting',
    DOWNLOADING: 'downloading',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    ERROR: 'error'
};

// 下载管理类
class DownloadManager {
    constructor() {
        this.downloadQueue = new Map(); // 存储所有下载任务
        this.initEventListeners();
    }

    // 初始化事件监听
    initEventListeners() {
        // 下载按钮点击事件
        const downloadBtn = document.querySelector('.download-btn');
        downloadBtn.addEventListener('click', () => this.startDownload());

        // 输入框回车事件
        const input = document.querySelector('.video-input');
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.startDownload();
            }
        });
    }

    // 开始下载
    async startDownload() {
        const input = document.querySelector('.video-input');
        const url = input.value.trim();

        if (!this.validateUrl(url)) {
            alert('请输入有效的B站视频链接！');
            return;
        }

        try {
            // 创建下载任务
            const taskId = await this.createDownloadTask(url);
            
            // 添加下载卡片到UI
            this.addDownloadCard(taskId, url);
            
            // 连接WebSocket监听下载进度
            this.connectWebSocket(taskId);
            
            // 清空输入框
            input.value = '';
        } catch (error) {
            console.error('下载失败:', error);
            alert('下载失败，请重试！');
        }
    }

    // 验证B站链接
    validateUrl(url) {
        return url.match(/^https?:\/\/(www\.)?bilibili\.com\/video\/(av|BV)[a-zA-Z0-9]+/);
    }

    // 创建下载任务
    async createDownloadTask(url) {
        const response = await fetch(`${API_BASE_URL}/download`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url })
        });

        if (!response.ok) {
            throw new Error('创建下载任务失败');
        }

        const data = await response.json();
        return data.taskId;
    }

    // 添加下载卡片到UI
    addDownloadCard(taskId, url) {
        const card = this.createDownloadCardElement(taskId);
        const container = document.querySelector('.downloads-grid');
        container.insertBefore(card, container.firstChild);
    }

    // 创建下载卡片元素
    createDownloadCardElement(taskId) {
        const card = document.createElement('div');
        card.className = 'download-card';
        card.dataset.taskId = taskId;
        
        // 添加卡片HTML结构
        card.innerHTML = `
            <div class="download-card__thumbnail-container">
                <img src="" alt="视频缩略图" class="download-card__thumbnail">
                <div class="download-card__actions">
                    <button class="action-btn action-btn--pause" title="暂停">⏸️</button>
                    <button class="action-btn" title="取消">⏹️</button>
                    <button class="action-btn" title="设置">⚙️</button>
                </div>
            </div>
            <div class="download-card__content">
                <h3 class="download-card__title">正在获取视频信息...</h3>
                <div class="download-card__info">
                    <span class="quality-badge">--</span>
                    <span class="size-info">等待中...</span>
                </div>
                <div class="download-card__progress">
                    <div class="download-card__progress-bar download-card__progress-bar--active" style="width: 0%"></div>
                </div>
                <div class="download-card__status">
                    <span class="download-card__status--waiting">
                        <i class="status-icon">⏳</i>
                        等待下载
                    </span>
                    <span class="download-speed">--</span>
                </div>
            </div>
        `;

        // 添加事件监听
        this.addCardEventListeners(card);
        
        return card;
    }

    // 添加卡片事件监听
    addCardEventListeners(card) {
        const pauseBtn = card.querySelector('.action-btn--pause');
        const cancelBtn = card.querySelector('[title="取消"]');
        const settingsBtn = card.querySelector('[title="设置"]');

        pauseBtn.addEventListener('click', () => this.togglePause(card.dataset.taskId));
        cancelBtn.addEventListener('click', () => this.cancelDownload(card.dataset.taskId));
        settingsBtn.addEventListener('click', () => this.showSettings(card.dataset.taskId));
    }

    // 连接WebSocket监听下载进度
    connectWebSocket(taskId) {
        // 使用 Socket.IO 替代原生 WebSocket
        const socket = io('/ws/progress');
        
        socket.on('connect', () => {
            console.log('WebSocket 连接成功');
        });
        
        socket.on('download_progress', (data) => {
            if (data.taskId === taskId) {
                this.updateDownloadProgress(taskId, data);
            }
        });

        socket.on('download_complete', (data) => {
            if (data.taskId === taskId) {
                this.updateDownloadStatus(taskId, DownloadStatus.COMPLETED);
            }
        });

        socket.on('download_error', (data) => {
            if (data.taskId === taskId) {
                this.updateDownloadStatus(taskId, DownloadStatus.ERROR);
                console.error('下载错误:', data.error);
            }
        });

        socket.on('connect_error', (error) => {
            console.error('Socket.IO 连接错误:', error);
            this.updateDownloadStatus(taskId, DownloadStatus.ERROR);
        });

        this.downloadQueue.set(taskId, { socket });
    }

    // 更新下载进度
    updateDownloadProgress(taskId, data) {
        const card = document.querySelector(`.download-card[data-task-id="${taskId}"]`);
        if (!card) return;

        const progressBar = card.querySelector('.download-card__progress-bar');
        const speedElement = card.querySelector('.download-speed');
        const statusElement = card.querySelector('.download-card__status span:first-child');

        progressBar.style.width = `${data.progress}%`;
        speedElement.textContent = `${data.speed} MB/s`;
        statusElement.innerHTML = `
            <i class="status-icon">↓</i>
            下载中 ${data.progress}%
        `;

        // 更新其他信息
        if (data.title) {
            card.querySelector('.download-card__title').textContent = data.title;
        }
        if (data.thumbnail) {
            card.querySelector('.download-card__thumbnail').src = data.thumbnail;
        }
    }

    // 暂停/继续下载
    async togglePause(taskId) {
        try {
            const response = await fetch(`${API_BASE_URL}/download/${taskId}/toggle`, {
                method: 'POST'
            });
            
            if (!response.ok) throw new Error('操作失败');
            
            const button = document.querySelector(`.download-card[data-task-id="${taskId}"] .action-btn--pause`);
            button.textContent = button.textContent === '⏸️' ? '▶️' : '⏸️';
            button.title = button.title === '暂停' ? '继续' : '暂停';
        } catch (error) {
            console.error('切换下载状态失败:', error);
            alert('操作失败，请重试！');
        }
    }

    // 取消下载
    async cancelDownload(taskId) {
        if (!confirm('确定要取消此下载任务吗？')) return;

        try {
            await fetch(`${API_BASE_URL}/download/${taskId}`, {
                method: 'DELETE'
            });
            
            const card = document.querySelector(`.download-card[data-task-id="${taskId}"]`);
            card.remove();
            
            // 关闭 Socket.IO 连接
            const task = this.downloadQueue.get(taskId);
            if (task && task.socket) {
                task.socket.disconnect();
            }
            this.downloadQueue.delete(taskId);
        } catch (error) {
            console.error('取消下载失败:', error);
            alert('取消下载失败，请重试！');
        }
    }

    // 显示设置
    showSettings(taskId) {
        // TODO: 实现设置弹窗
        alert('设置功能开发中...');
    }
}

// 添加设置相关的代码
class Settings {
    constructor() {
        this.dialog = document.getElementById('settingsDialog');
        this.settingsBtn = document.getElementById('settingsBtn');
        this.closeBtn = document.getElementById('closeDialogBtn');
        this.saveBtn = document.getElementById('saveCookiesBtn');
        this.cookiesInput = document.getElementById('cookiesInput');
        
        this.initEventListeners();
    }
    
    initEventListeners() {
        this.settingsBtn.addEventListener('click', () => this.showDialog());
        this.closeBtn.addEventListener('click', () => this.hideDialog());
        this.saveBtn.addEventListener('click', () => this.saveCookies());
        
        // 点击对话框外部关闭
        this.dialog.addEventListener('click', (e) => {
            if (e.target === this.dialog) {
                this.hideDialog();
            }
        });
    }
    
    showDialog() {
        this.dialog.style.display = 'flex';
    }
    
    hideDialog() {
        this.dialog.style.display = 'none';
    }
    
    async saveCookies() {
        const cookies = this.cookiesInput.value.trim();
        if (!cookies) {
            alert('请输入cookies');
            return;
        }
        
        try {
            const response = await fetch('/api/cookies', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ cookies })
            });
            
            if (!response.ok) throw new Error('保存失败');
            
            alert('cookies保存成功！');
            this.hideDialog();
        } catch (error) {
            console.error('保存cookies失败:', error);
            alert('保存失败，请重试！');
        }
    }
}

// 初始化下载管理器
document.addEventListener('DOMContentLoaded', () => {
    window.downloadManager = new DownloadManager();
    window.settings = new Settings();
}); 