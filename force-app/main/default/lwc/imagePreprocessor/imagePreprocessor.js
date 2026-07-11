const CJK_LANGUAGES = ["japanese", "chinese", "zh", "korean"];

function toGrayscale(imageData) {
    const { data, width, height } = imageData;
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0; i < gray.length; i++) {
        const offset = i * 4;
        gray[i] = Math.round(
            0.299 * data[offset] +
                0.587 * data[offset + 1] +
                0.114 * data[offset + 2]
        );
    }
    return gray;
}

function equalizeHistogram(gray, clipLimit = 2) {
    const histogram = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) {
        histogram[gray[i]] += 1;
    }
    const maxCount = Math.max(1, Math.round((clipLimit * gray.length) / 256));
    let excess = 0;
    for (let level = 0; level < 256; level++) {
        if (histogram[level] > maxCount) {
            excess += histogram[level] - maxCount;
            histogram[level] = maxCount;
        }
    }
    const redistribution = excess / 256;
    let cumulative = 0;
    const mapping = new Uint8ClampedArray(256);
    for (let level = 0; level < 256; level++) {
        cumulative += histogram[level] + redistribution;
        mapping[level] = Math.round((cumulative / gray.length) * 255);
    }
    const result = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) {
        result[i] = mapping[gray[i]];
    }
    return result;
}

function medianFilter(gray, width, height) {
    const result = new Uint8ClampedArray(gray);
    const window = new Array(9);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            let index = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    window[index] = gray[(y + dy) * width + (x + dx)];
                    index += 1;
                }
            }
            window.sort((a, b) => a - b);
            result[y * width + x] = window[4];
        }
    }
    return result;
}

function otsuThreshold(gray) {
    const histogram = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) {
        histogram[gray[i]] += 1;
    }
    const total = gray.length;
    let sumAll = 0;
    for (let level = 0; level < 256; level++) {
        sumAll += level * histogram[level];
    }
    let sumBackground = 0;
    let weightBackground = 0;
    let bestVariance = -1;
    let threshold = 0;
    for (let level = 0; level < 256; level++) {
        weightBackground += histogram[level];
        if (weightBackground === 0) {
            continue;
        }
        const weightForeground = total - weightBackground;
        if (weightForeground === 0) {
            break;
        }
        sumBackground += level * histogram[level];
        const meanBackground = sumBackground / weightBackground;
        const meanForeground = (sumAll - sumBackground) / weightForeground;
        const variance =
            weightBackground *
            weightForeground *
            (meanBackground - meanForeground) *
            (meanBackground - meanForeground);
        if (variance > bestVariance) {
            bestVariance = variance;
            threshold = level;
        }
    }
    return threshold;
}

function applyBinaryInverted(gray, threshold) {
    const result = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) {
        result[i] = gray[i] > threshold ? 0 : 255;
    }
    return result;
}

function adaptiveThresholdInverted(
    gray,
    width,
    height,
    windowSize = 11,
    c = 2
) {
    const integral = new Float64Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y++) {
        let rowSum = 0;
        for (let x = 0; x < width; x++) {
            rowSum += gray[y * width + x];
            integral[(y + 1) * (width + 1) + (x + 1)] =
                integral[y * (width + 1) + (x + 1)] + rowSum;
        }
    }
    const radius = Math.floor(windowSize / 2);
    const result = new Uint8ClampedArray(gray.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const x0 = Math.max(0, x - radius);
            const y0 = Math.max(0, y - radius);
            const x1 = Math.min(width - 1, x + radius);
            const y1 = Math.min(height - 1, y + radius);
            const area = (x1 - x0 + 1) * (y1 - y0 + 1);
            const sum =
                integral[(y1 + 1) * (width + 1) + (x1 + 1)] -
                integral[y0 * (width + 1) + (x1 + 1)] -
                integral[(y1 + 1) * (width + 1) + x0] +
                integral[y0 * (width + 1) + x0];
            const localMean = sum / area;
            result[y * width + x] =
                gray[y * width + x] > localMean - c ? 0 : 255;
        }
    }
    return result;
}

function preprocessImageData(imageData, language = "en") {
    const { width, height } = imageData;
    let gray = toGrayscale(imageData);
    gray = equalizeHistogram(gray);
    gray = medianFilter(gray, width, height);
    const isCjk = CJK_LANGUAGES.includes((language || "").toLowerCase());
    const output = isCjk
        ? adaptiveThresholdInverted(gray, width, height)
        : applyBinaryInverted(gray, otsuThreshold(gray));
    for (let i = 0; i < output.length; i++) {
        const offset = i * 4;
        imageData.data[offset] = output[i];
        imageData.data[offset + 1] = output[i];
        imageData.data[offset + 2] = output[i];
        imageData.data[offset + 3] = 255;
    }
    return imageData;
}

async function preprocessImageBlob(blob, language = "en") {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    preprocessImageData(imageData, language);
    context.putImageData(imageData, 0, 0);
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (result) => {
                if (result) {
                    resolve(result);
                } else {
                    reject(new Error("Could not encode preprocessed image."));
                }
            },
            "image/jpeg",
            0.95
        );
    });
}

export {
    toGrayscale,
    equalizeHistogram,
    medianFilter,
    otsuThreshold,
    applyBinaryInverted,
    adaptiveThresholdInverted,
    preprocessImageData,
    preprocessImageBlob
};
