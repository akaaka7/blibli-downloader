from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from flask_socketio import SocketIO
import os
import logging
import uuid
import threading
from datetime import datetime
import warnings
import subprocess
import json
import re

# 配置日志
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# 获取当前文件的目录
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 添加 cookies 文件路径配置
COOKIES_FILE = os.path.join(BASE_DIR, 'cookies.txt')

# 初始化 Flask 应用
app = Flask(__name__,
    template_folder=os.path.join(BASE_DIR, 'templates'),
    static_folder=os.path.join(BASE_DIR, 'static'),
    static_url_path='/static'
)

# 添加模板调试
app.config['TEMPLATES_AUTO_RELOAD'] = True
app.jinja_env.auto_reload = True

# 配置CORS
CORS(app)

# 配置 SocketIO
socketio = SocketIO(app, cors_allowed_origins="*")

# 添加调试路由
@app.route('/debug/paths')
def debug_paths():
    return {
        'BASE_DIR': BASE_DIR,
        'template_folder': app.template_folder,
        'static_folder': app.static_folder,
        'templates_exists': os.path.exists(app.template_folder),
        'index_exists': os.path.exists(os.path.join(app.template_folder, 'index.html')),
        'static_exists': os.path.exists(app.static_folder)
    }

@app.route('/')
def index():
    try:
        # 改回渲染 index.html
        return render_template('index.html')
    except Exception as e:
        logger.error(f"渲染模板错误: {str(e)}")
        return jsonify({
            'error': str(e),
            'template_folder': app.template_folder,
            'templates_list': os.listdir(app.template_folder)
        }), 500

# 存储下载任务
download_tasks = {}

class DownloadTask:
    def __init__(self, url, format=None):
        self.id = str(uuid.uuid4())
        self.url = url
        self.format = format  # 添加格式选择
        self.progress = 0
        self.status = 'waiting'
        self.speed = '0 MB/s'
        self.title = None
        self.thumbnail = None
        self.start_time = datetime.now()
        self.total_size = 0
        self.downloaded_size = 0
        self.thread = None
        self.process = None
        self.download_path = os.path.join('downloads', 'videos')
        self.cookies_file = COOKIES_FILE

    def start(self):
        self.status = 'downloading'
        self.thread = threading.Thread(target=self._download)
        self.thread.start()

    def _get_video_info(self):
        """获取视频信息"""
        try:
            # 使用 you-get 获取视频信息，指定编码为 utf-8
            cmd = ['you-get', '-i', self.url]
            result = subprocess.run(
                cmd, 
                capture_output=True, 
                text=True,
                encoding='utf-8'  # 指定编码为 utf-8
            )
            
            logger.info(f"视频信息输出: {result.stdout}")
            
            # 解析视频标题
            title_match = re.search(r'Title:\s+(.+)', result.stdout)
            if title_match:
                self.title = title_match.group(1)
            
            # 解析视频大小
            size_match = re.search(r'Size:\s+(.+) \(', result.stdout)
            if size_match:
                size_str = size_match.group(1)
                if 'MiB' in size_str:
                    self.total_size = float(size_str.replace('MiB', '').strip()) * 1024 * 1024
                elif 'GiB' in size_str:
                    self.total_size = float(size_str.replace('GiB', '').strip()) * 1024 * 1024 * 1024
            
            return True
        except Exception as e:
            logger.error(f"获取视频信息失败: {str(e)}")
            return False

    def _download(self):
        """实际的下载实现"""
        try:
            logger.info(f"开始下载视频: {self.url}")
            
            # 获取视频信息
            if not self._get_video_info():
                raise Exception("无法获取视频信息")

            # 创建下载目录
            os.makedirs(self.download_path, exist_ok=True)
            
            # 构建下载命令，指定下载 360P 版本
            cmd = ['you-get', '--format', 'dash-flv360-AVC']
            cmd.extend([
                '--output-dir', self.download_path,
                '--output-filename', f'{self.id}',
                self.url
            ])
            
            logger.info(f"下载命令: {' '.join(cmd)}")
            
            # 指定编码为 utf-8
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True,
                encoding='utf-8',
                bufsize=1  # 行缓冲
            )
            
            # 监控下载进度
            while True:
                # 读取错误输出（you-get 的进度信息在 stderr 中）
                line = self.process.stderr.readline()
                if not line and self.process.poll() is not None:
                    break
                    
                # 记录输出
                logger.debug(f"下载输出: {line.strip()}")
                    
                # 解析下载进度
                if '%' in line:
                    try:
                        # 尝试匹配进度
                        progress_match = re.search(r'(\d+\.?\d*)%', line)
                        if progress_match:
                            self.progress = float(progress_match.group(1))
                        
                        # 尝试匹配速度
                        speed_match = re.search(r'(\d+\.?\d*\s*[KMG]B/s)', line)
                        if speed_match:
                            self.speed = speed_match.group(1)
                        
                        # 发送进度更新
                        socketio.emit('download_progress', {
                            'taskId': self.id,
                            'progress': self.progress,
                            'speed': self.speed,
                            'title': self.title,
                            'thumbnail': self.thumbnail
                        }, namespace='/ws/progress')
                        
                        logger.debug(f"发送进度更新: {self.progress}%, {self.speed}")
                    except Exception as e:
                        logger.error(f"解析进度失败: {str(e)}")
            
            # 检查下载结果
            if self.process.returncode == 0:
                self.status = 'completed'
                socketio.emit('download_complete', {'taskId': self.id}, namespace='/ws/progress')
                logger.info(f"下载完成: {self.url}")
            else:
                error_output = self.process.stderr.read()
                raise Exception(f"下载失败: {error_output}")
                
        except Exception as e:
            logger.error(f"下载错误: {str(e)}")
            self.status = 'error'
            socketio.emit('download_error', {
                'taskId': self.id,
                'error': str(e)
            }, namespace='/ws/progress')

    def cancel(self):
        """取消下载"""
        if self.process:
            self.process.terminate()
        self.status = 'cancelled'

# 路由配置
@app.route('/api/download', methods=['POST', 'OPTIONS'])
def create_download():
    logger.info(f"收到请求: {request.method}")
    
    # 处理 OPTIONS 请求
    if request.method == 'OPTIONS':
        response = app.make_default_options_response()
        response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        return response

    try:
        logger.info(f"请求数据: {request.data}")
        data = request.get_json()
        url = data.get('url')
        format = data.get('format')  # 添加格式参数
        
        if not url:
            return jsonify({'error': 'Missing URL'}), 400
        
        logger.info(f"创建下载任务: {url}, 格式: {format}")
        task = DownloadTask(url, format)  # 传入格式参数
        download_tasks[task.id] = task
        task.start()
        
        return jsonify({
            'taskId': task.id,
            'status': 'created'
        })
    except Exception as e:
        logger.error(f"处理下载请求错误: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/download/<task_id>/toggle', methods=['POST'])
def toggle_download(task_id):
    logger.info(f"切换下载状态: {task_id}")
    task = download_tasks.get(task_id)
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    
    return jsonify({'status': 'success'})

@app.route('/api/download/<task_id>', methods=['DELETE'])
def cancel_download(task_id):
    logger.info(f"取消下载: {task_id}")
    task = download_tasks.get(task_id)
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    
    task.cancel()
    del download_tasks[task_id]
    return jsonify({'status': 'success'})

@socketio.on('connect', namespace='/ws/progress')
def handle_progress_connect():
    logger.info('客户端连接到进度 WebSocket')

@socketio.on('disconnect', namespace='/ws/progress')
def handle_progress_disconnect():
    logger.info('客户端断开进度 WebSocket 连接')

@app.route('/api/cookies', methods=['POST'])
def update_cookies():
    try:
        cookies = request.get_json().get('cookies')
        if not cookies:
            return jsonify({'error': 'Missing cookies'}), 400
            
        # 确保使用 UTF-8 编码保存 cookies
        with open(COOKIES_FILE, 'w', encoding='utf-8') as f:
            f.write(cookies.strip())  # 去除可能的多余空格
            
        logger.info("Cookies 保存成功")
        return jsonify({'status': 'success'})
    except Exception as e:
        logger.error(f"更新 cookies 失败: {str(e)}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    logger.info("启动服务器...")
    # 确保下载目录存在
    os.makedirs(os.path.join('downloads', 'videos'), exist_ok=True)
    warnings.filterwarnings('ignore')
    socketio.run(app, debug=True, port=8000)  # 使用 socketio.run 