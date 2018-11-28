const Matrix = require('transformation-matrix');
const log = require('./util/log');

/**
 * @fileOverview Apply transforms to match stroke width appearance in 2.0 and 3.0
 */

// Adapted from paper.js's Path.applyTransform
const _parseTransform = function (domElement) {
    let matrix = Matrix.identity();
    const string = domElement.attributes && domElement.attributes.transform && domElement.attributes.transform.value;
    if (!string) return matrix;
    // https://www.w3.org/TR/SVG/types.html#DataTypeTransformList
    // Parse SVG transform string. First we split at /)\s*/, to separate
    // commands
    const transforms = string.split(/\)\s*/g);
    for (const transform of transforms) {
        if (!transform) break;
        // Command come before the '(', values after
        const parts = transform.split(/\(\s*/);
        const command = parts[0].trim();
        const v = parts[1].split(/[\s,]+/g);
        // Convert values to floats
        for (let j = 0; j < v.length; j++) {
            v[j] = parseFloat(v[j]);
        }
        switch (command) {
        case 'matrix':
            matrix = Matrix.compose(matrix, {a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5]});
            break;
        case 'rotate':
            matrix = matrix.rotateDEG(v[0], v[1] || 0, v[2] || 0);
            break;
        case 'translate':
            matrix = matrix.translate(v[0], v[1] || 0);
            break;
        case 'scale':
            matrix = matrix.scale(v[0], v[1] || v[0]);
            break;
        case 'skewX':
            matrix = matrix.skewDEG(v[0], 0);
            break;
        case 'skewY':
            matrix = matrix.skewDEG(0, v[0]);
            break;
        default:
            log.error(`Couldn't parse: ${command}`);
        }
    }
    return matrix;
};

// Adapted from paper.js's Matrix.decompose
// Given a matrix, return the x and y scale factors of the matrix
const _getScaleFactor = function (matrix) {
    const a = matrix.a;
    const b = matrix.b;
    const c = matrix.c;
    const d = matrix.d;
    const det = (a * d) - (b * c);

    if (a !== 0 || b !== 0) {
        const r = Math.sqrt((a * a) + (b * b));
        return {x: r, y: det / r};
    }
    if (c !== 0 || d !== 0) {
        const s = Math.sqrt((c * c) + (d * d));
        return {x: det / s, y: s};
    }
    // a = b = c = d = 0
    return {x: 0, y: 0};
};

// Adapted from paper.js's PathItem.setPathData
const _transformPath = function (pathString, transform) {
    if (!transform || Matrix.toString(transform) === Matrix.toString(Matrix.identity())) return pathString;
    // First split the path data into parts of command-coordinates pairs
    // Commands are any of these characters: mzlhvcsqta
    const parts = pathString && pathString.match(/[mlhvcsqtaz][^mlhvcsqtaz]*/ig);
    let coords;
    let relative = false;
    let previous;
    let control;
    let current = {x: 0, y: 0};
    let start = {x: 0, y: 0};
    let translated = '';

    const getCoord = function (index, coord) {
        let val = +coords[index];
        if (relative) {
            val += current[coord];
        }
        return val;
    };

    const getPoint = function (index) {
        return {x: getCoord(index, 'x'), y: getCoord(index + 1, 'y')};
    };

    // Returns the transformed point as a string
    const getString = function (point) {
        const transformed = Matrix.applyToPoint(transform, point);
        return `${transformed.x} ${transformed.y} `;
    };

    for (let i = 0, l = parts && parts.length; i < l; i++) {
        const part = parts[i];
        const command = part[0];
        const lower = command.toLowerCase();
        // Match all coordinate values
        coords = part.match(/[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g);
        const length = coords && coords.length;
        relative = command === lower;
        // Fix issues with z in the middle of SVG path data, not followed by
        // a m command, see paper.js#413:
        if (previous === 'z' && !/[mz]/.test(lower)) {
            translated += `M ${current.x} ${current.y} `;
        }
        switch (lower) {
        case 'm':
        case 'l':
            {
                let move = lower === 'm';
                for (let j = 0; j < length; j += 2) {
                    translated += move ? 'M ' : 'L ';
                    current = getPoint(j);
                    translated += getString(current);
                    if (move) {
                        start = current;
                        move = false;
                    }
                }
                control = current;
                break;
            }
        case 'h':
        case 'v':
            {
                const coord = lower === 'h' ? 'x' : 'y';
                current = current.clone(); // Clone as we're going to modify it.
                for (let j = 0; j < length; j++) {
                    current[coord] = getCoord(j, coord);
                    translated += `L ${getString(current)}`;
                }
                control = current;
                break;
            }
        case 'c':
            for (let j = 0; j < length; j += 6) {
                const handle1 = getPoint(j);
                const handle2 = getPoint(j + 2);
                current = getPoint(j + 4);
                translated += `C ${getString(handle1)}${getString(handle2)}${getString(current)}`;
            }
            break;
        case 's':
            // Smooth cubicCurveTo
            for (let j = 0; j < length; j += 4) {

                const handle1 = /[cs]/.test(previous) ?
                                current.multiply(2).subtract(control) :
                                current;
                const handle2 = getPoint(j);
                current = getPoint(j + 2);

                translated += `C ${getString(handle1)}${getString(handle2)}${getString(current)}`;
                previous = lower;
            }
            break;
        case 'q':
            for (let j = 0; j < length; j += 4) {
                const handle = getPoint(j);
                current = getPoint(j + 2);
                translated += `Q ${getString(handle)}${getString(current)}`;
            }
            break;
        case 't':
            // Smooth quadraticCurveTo
            for (let j = 0; j < length; j += 2) {
                const handle = /[qt]/.test(previous) ?
                                current.multiply(2).subtract(control) :
                                current;
                current = getPoint(j);
                translated += `Q ${getString(handle)}${getString(current)}`;
                previous = lower;
            }
            break;
        case 'a':
            // TODO figure out what to do with A...
            for (let j = 0; j < length; j += 7) {
                current = getPoint(j + 5);
                const scale = _getScaleFactor(transform);
                translated += `A ${+coords[j]} ${+coords[j + 1]} ` +
                    `${+coords[j + 2]} ${+coords[j + 3]} ` +
                    `${+coords[j + 4]} ${getString(current)}`;
            }
            break;
        case 'z':
            translated += `Z `;
            // Correctly handle relative m commands, see paper.js#1101:
            current = start;
            break;
        }
        previous = lower;
    }
    return translated;
};

/**
 * Scratch 2.0 displays stroke widths in a "normalized" way, that is,
 * if a shape with a stroke width has a transform applied, it will be
 * rendered with a stroke that is the same width all the way around,
 * instead of stretched looking.
 *
 * The vector paint editor also prefers to normalize the stroke width,
 * rather than keep track of transforms at the group level, as this
 * simplifies editing (e.g. stroke width 3 always means the same thickness)
 *
 * This function performs that normalization process, pushing transforms
 * on groups down to the leaf level and averaging out the stroke width
 * around the shapes.
 *
 * @param {SVGElement} svgTag The SVG dom object
 * @return {void}
 */
const transformStrokeWidths = function (svgTag) {
    const inherited = Matrix.identity();
    const applyTransforms = (domElement, matrix, strokeWidth) => {
        if (domElement.childNodes.length) {
            if (domElement.attributes && domElement.attributes['stroke-width']) {
                strokeWidth = domElement.attributes['stroke-width'].value;
            }
            for (let i = 0; i < domElement.childNodes.length; i++) {
                applyTransforms(
                    domElement.childNodes[i],
                    Matrix.compose(matrix, _parseTransform(domElement)),
                    strokeWidth
                );
            }
            if (domElement.attributes) {
                domElement.removeAttribute('transform');
                domElement.removeAttribute('stroke-width');
            }
        } else if (domElement.localName === 'path' &&
                domElement.attributes &&
                (strokeWidth || domElement.attributes['stroke-width']) &&
                domElement.attributes.d &&
                domElement.attributes.d.value) {

            if (domElement.attributes['stroke-width']) {
                strokeWidth = domElement.attributes['stroke-width'].value;
            }

            matrix = Matrix.compose(matrix, _parseTransform(domElement));
            domElement.setAttribute('d', _transformPath(domElement.attributes.d.value, matrix));
            domElement.removeAttribute('transform');

            const matrixScale = _getScaleFactor(matrix);
            const quadraticMean = Math.sqrt(((matrixScale.x * matrixScale.x) + (matrixScale.y * matrixScale.y)) / 2);
            domElement.setAttribute('stroke-width', quadraticMean * strokeWidth);
        } else {
            // Push stroke width down to leaves
            if (strokeWidth && (!domElement.attributes || !domElement.attributes['stroke-width'])) {
                domElement.setAttribute('stroke-width', strokeWidth);
            }

            // Push transform down to leaves
            matrix = Matrix.compose(matrix, _parseTransform(domElement));
            if (Matrix.toString(matrix) === Matrix.toString(Matrix.identity())) {
                if (domElement.attributes) domElement.removeAttribute('transform');
            } else {
                domElement.setAttribute('transform', Matrix.toString(matrix));
            }
        }
    };
    applyTransforms(svgTag, inherited);
};

module.exports = transformStrokeWidths;
