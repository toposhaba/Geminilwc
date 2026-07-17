import {
    toGrayscale,
    equalizeHistogram,
    medianFilter,
    otsuThreshold,
    applyBinaryInverted,
    adaptiveThresholdInverted,
    preprocessImageData
} from "c/imagePreprocessor";

function makeImageData(pixels, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    pixels.forEach((value, index) => {
        const offset = index * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
    });
    return { data, width, height };
}

describe("c-image-preprocessor", () => {
    it("converts pixels to grayscale using luminosity weights", () => {
        const data = new Uint8ClampedArray([
            255, 0, 0, 255, 255, 255, 255, 255
        ]);
        const gray = toGrayscale({ data, width: 2, height: 1 });
        expect(gray[0]).toBe(76);
        expect(gray[1]).toBe(255);
    });

    it("stretches contrast when equalizing a low-contrast histogram", () => {
        const gray = new Uint8ClampedArray(256);
        for (let i = 0; i < gray.length; i++) {
            gray[i] = 100 + (i % 20);
        }
        const equalized = equalizeHistogram(gray);
        const originalRange = 19;
        const equalizedRange = Math.max(...equalized) - Math.min(...equalized);
        expect(equalizedRange).toBeGreaterThan(originalRange);
    });

    it("removes isolated salt noise with the median filter", () => {
        const pixels = new Array(25).fill(100);
        pixels[12] = 255;
        const gray = new Uint8ClampedArray(pixels);
        const filtered = medianFilter(gray, 5, 5);
        expect(filtered[12]).toBe(100);
    });

    it("finds a threshold separating a bimodal histogram", () => {
        const pixels = [...new Array(50).fill(20), ...new Array(50).fill(220)];
        const threshold = otsuThreshold(new Uint8ClampedArray(pixels));
        expect(threshold).toBeGreaterThanOrEqual(20);
        expect(threshold).toBeLessThan(220);
    });

    it("inverts the binary output so dark text becomes white", () => {
        const gray = new Uint8ClampedArray([20, 220]);
        const output = applyBinaryInverted(gray, 128);
        expect(output[0]).toBe(255);
        expect(output[1]).toBe(0);
    });

    it("adapts thresholds to local neighborhoods", () => {
        const width = 6;
        const height = 6;
        const pixels = [];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                pixels.push(x < 3 ? 40 : 200);
            }
        }
        const output = adaptiveThresholdInverted(
            new Uint8ClampedArray(pixels),
            width,
            height,
            3,
            2
        );
        expect(output[2 * width + 2]).toBe(255);
        expect(output[2 * width + 4]).toBe(0);
    });

    it("binarizes dark regions to white and light regions to black end-to-end", () => {
        const width = 6;
        const height = 6;
        const pixels = [];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                pixels.push(x < 3 ? 30 : 220);
            }
        }
        const imageData = makeImageData(pixels, width, height);
        preprocessImageData(imageData, "en");

        const leftPixel = imageData.data[(2 * width + 1) * 4];
        const rightPixel = imageData.data[(2 * width + 4) * 4];
        expect(leftPixel).toBe(255);
        expect(rightPixel).toBe(0);
    });
});
