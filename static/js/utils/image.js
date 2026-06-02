(function (window) {
    'use strict';

    async function compressImage(file, maxWidth = 1600, quality = 0.85) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);

            reader.onload = (event) => {
                const img = new Image();
                img.src = event.target.result;

                img.onload = () => {
                    let width = img.width;
                    let height = img.height;
                    if (width > maxWidth) {
                        height = Math.round((height * maxWidth) / width);
                        width = maxWidth;
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    canvas.getContext('2d').drawImage(img, 0, 0, width, height);

                    canvas.toBlob((blob) => {
                        if (!blob) {
                            reject(new Error('图片压缩失败'));
                            return;
                        }
                        const baseName = String(file.name || `diary-image-${Date.now()}`)
                            .replace(/\.[^.]+$/, '')
                            .replace(/[^\w\u4e00-\u9fff-]+/g, '_')
                            || `diary-image-${Date.now()}`;
                        // canvas 压缩输出固定为 JPEG，文件扩展名也必须同步成 .jpg，
                        // 否则后端魔数校验会把“PNG 文件名 + JPEG 内容”当作异常图片跳过。
                        resolve(new File([blob], `${baseName}.jpg`, { type: 'image/jpeg', lastModified: Date.now() }));
                    }, 'image/jpeg', quality);
                };

                img.onerror = reject;
            };

            reader.onerror = reject;
        });
    }

    window.LeafVaultImageUtils = {
        compressImage,
    };
    window.compressImage = compressImage;
})(window);
