[![Mozilla Add-on](https://img.shields.io/amo/v/multithreaded-download-manager.svg?style=flat-square)](https://addons.mozilla.org/firefox/addon/multithreaded-download-manager/) [![Mozilla Add-on](https://img.shields.io/amo/d/multithreaded-download-manager.svg?style=flat-square)](https://addons.mozilla.org/firefox/addon/multithreaded-download-manager/)

# Multithreaded Download Manager

Experimental Firefox 57 extension: download manager with multithreading support.

#### Important note:

* **This extension is experimental. Use at your own risk.**
* The requested file is first downloaded to Firefox's internal storage and then moved to the default download folder. Make sure there is enough disk space.
* It is suggested to remove or pause all the tasks before exiting Firefox or performing updates. The extension can resume downloads after the update or the next start of Firefox (losing only about 1 second's progress), though this feature is less tested.
* If the feature "out of process extensions" (enabled by default in Windows, disabled by default in Linux) is disabled, the browser will have problem saving the downloaded file. The extension can workaround it but an additional copy is required. It may also cause the popup window to be blank (resizing can fix it).
* Firefox limits the number of simultaneous connections to a single server. If more than 6 threads are needed, increase network.http.max-persistent-connections-per-server and network.http.max-persistent-connections-per-proxy in about:config .
* The extension requires access to the internal storage (indexedDB) and does not work with the "always private browsing" mode without granting exceptions


This extension can download files with multiple connections to the server. Depending on the network condition, this may increase the download speed.

Click the toolbar button to open the download panel. Alternatively, right click the button to open in a new tab or window. Download tasks can be created by clicking the buttons at the bottom of the panel, or in the context menu of links on websites.
Monitoring download can be enabled in the options. When it is enabled, files larger than a configured size will automatically trigger the download dialog. Click "continue in browser" to switch to Firefox's built-in download.

---

# 多线程下载管理器

（实验性）火狐 57 扩展：支持多线程的下载管理器。

#### 重要说明：

* **这个扩展仍在测试阶段。请自担风险。**
* 下载的文件会先保存到火狐的内部存储，然后移动到默认的下载目录。确认磁盘有足够的空间。
* 建议在退出浏览器或更新之前删除或暂停所有下载任务。扩展可以在更新或重新启动后恢复下载（会失去约1秒进度），但这个功能测试较少。
* 如果禁用了火狐的“主进程外扩展”功能（Windows下默认启用，Linux下默认禁用），浏览器保存下载文件时会出错。扩展可以自动纠正这个错误，但需要一次额外的文件复制。这也可能导致弹出窗口为空白（调整大小来修复）。
* 火狐对同一服务器的同时连接数有限制。如果需要多于6个线程，在 about:config 中增加 network.http.max-persistent-connections-per-server 和 network.http.max-persistent-connections-per-proxy 的值。
* 这个扩展需要使用火狐的内部存储（indexedDB），因此在“始终使用隐私浏览”模式下（不设置例外）无法工作。

这个扩展可以使用多个连接下载文件。根据网络状况，这可能会提高下载速度。

单击工具栏按钮来打开下载面板，或者右击按钮在新标签页/新窗口中打开。单击面板底部按钮，或在下载链接的右键菜单中新建下载任务。

可在选项中启用监视下载功能，启用后打开大于指定大小的文件会自动弹出下载对话框。选择“在浏览器中继续”会切换到浏览器的内建下载。
