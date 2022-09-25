/**
 *
 * Worker script for browser and node
 *
 * @fileoverview Worker script for browser and node
 * @author Kevin Kwok <antimatter15@gmail.com>
 * @author Guillermo Webster <gui@mit.edu>
 * @author Jerome Wu <jeromewus@gmail.com>
 */
require('regenerator-runtime/runtime');
const fileType = require('file-type');
const isURL = require('is-url');
const dump = require('./utils/dump');
const isWebWorker = require('../utils/getEnvironment')('type') === 'webworker';
const setImage = require('./utils/setImage');
const defaultParams = require('./constants/defaultParams');
const defaultOutput = require('./constants/defaultOutput');
const { log, setLogging } = require('../utils/log');
const imageType = require('../constants/imageType');
const PSM = require('../constants/PSM');

/*
 * Tesseract Module returned by TesseractCore.
 */
let TessModule;
/*
 * TessearctBaseAPI instance
 */
let api = null;
let latestJob;
let adapter = {};
let params = defaultParams;

const load = async ({ workerId, jobId, payload: { options: { corePath, logging } } }, res) => {
  setLogging(logging);
  if (!TessModule) {
    const Core = await adapter.getCore(corePath, res);

    res.progress({ workerId, status: 'initializing tesseract', progress: 0 });

    Core({
      TesseractProgress(percent) {
        latestJob.progress({
          workerId,
          jobId,
          status: 'recognizing text',
          progress: Math.max(0, (percent - 30) / 70),
        });
      },
    }).then((tessModule) => {
      TessModule = tessModule;
      res.progress({ workerId, status: 'initialized tesseract', progress: 1 });
      res.resolve({ loaded: true });
    });
  } else {
    res.resolve({ loaded: true });
  }
};

const FS = async ({ workerId, payload: { method, args } }, res) => {
  log(`[${workerId}]: FS.${method} with args ${args}`);
  res.resolve(TessModule.FS[method](...args));
};

const loadLanguage = async ({
  workerId,
  payload: {
    langs,
    options: {
      langPath,
      dataPath,
      cachePath,
      cacheMethod,
      gzip = true,
    },
  },
},
res) => {
  const loadAndGunzipFile = async (_lang) => {
    const lang = typeof _lang === 'string' ? _lang : _lang.code;
    const readCache = ['refresh', 'none'].includes(cacheMethod)
      ? () => Promise.resolve()
      : adapter.readCache;
    let data = null;
    let newData = false;

    try {
      const _data = await readCache(`${cachePath || '.'}/${lang}.traineddata`);
      if (typeof _data !== 'undefined') {
        log(`[${workerId}]: Load ${lang}.traineddata from cache`);
        res.progress({ workerId, status: 'loading language traineddata (from cache)', progress: 0.5 });
        data = _data;
      } else {
        throw Error('Not found in cache');
      }
    } catch (e) {
      newData = true;
      log(`[${workerId}]: Load ${lang}.traineddata from ${langPath}`);
      if (typeof _lang === 'string') {
        let path = null;

        if (isURL(langPath) || langPath.startsWith('moz-extension://') || langPath.startsWith('chrome-extension://') || langPath.startsWith('file://')) { /** When langPath is an URL */
          path = langPath;
        }

        if (path !== null) {
          const fetchUrl = `${path}/${lang}.traineddata${gzip ? '.gz' : ''}`;
          const resp = await (isWebWorker ? fetch : adapter.fetch)(fetchUrl);
          if (!resp.ok) {
            throw Error(`Network error while fetching ${fetchUrl}. Response code: ${resp.status}`);
          }
          data = await resp.arrayBuffer();
        } else {
          data = await adapter.readCache(`${langPath}/${lang}.traineddata${gzip ? '.gz' : ''}`);
        }
      } else {
        data = _lang.data; // eslint-disable-line
      }
    }

    data = new Uint8Array(data);

    const type = fileType(data);
    if (typeof type !== 'undefined' && type.mime === 'application/gzip') {
      data = adapter.gunzip(data);
    }

    if (TessModule) {
      if (dataPath) {
        try {
          TessModule.FS.mkdir(dataPath);
        } catch (err) {
          res.reject(err.toString());
        }
      }
      TessModule.FS.writeFile(`${dataPath || '.'}/${lang}.traineddata`, data);
    }

    if (newData && ['write', 'refresh', undefined].includes(cacheMethod)) {
      try {
        await adapter.writeCache(`${cachePath || '.'}/${lang}.traineddata`, data);
      } catch (err) {
        log(`[${workerId}]: Failed to write ${lang}.traineddata to cache due to error:`);
        log(err.toString());
      }
    }

    return Promise.resolve(data);
  };

  res.progress({ workerId, status: 'loading language traineddata', progress: 0 });
  try {
    await Promise.all((typeof langs === 'string' ? langs.split('+') : langs).map(loadAndGunzipFile));
    res.progress({ workerId, status: 'loaded language traineddata', progress: 1 });
    res.resolve(langs);
  } catch (err) {
    if (isWebWorker && err instanceof DOMException) {
      /*
       * For some reason google chrome throw DOMException in loadLang,
       * while other browser is OK, for now we ignore this exception
       * and hopefully to find the root cause one day.
       */
    } else {
      res.reject(err.toString());
    }
  }
};

const setParameters = async ({ payload: { params: _params } }, res) => {
  Object.keys(_params)
    .filter((k) => !k.startsWith('tessjs_'))
    .forEach((key) => {
      api.SetVariable(key, _params[key]);
    });
  params = { ...params, ..._params };

  if (typeof res !== 'undefined') {
    res.resolve(params);
  }
};

const initialize = async ({
  workerId,
  payload: { langs: _langs, oem, config},
}, res) => {
  const langs = (typeof _langs === 'string')
    ? _langs
    : _langs.map((l) => ((typeof l === 'string') ? l : l.data)).join('+');

  try {
    res.progress({
      workerId, status: 'initializing api', progress: 0,
    });
    if (api !== null) {
      api.End();
    }
    let configFile = undefined;
    let configStr = undefined;
    // config argument may either be config file text, or object with key/value pairs
    // In the latter case we convert to config file text here
    if (typeof config === "object") {
      configStr = JSON.stringify(config).replace(/,/g, "\n").replace(/:/g, " ").replace(/["'{}]/g, "");
    } else {
      configStr = config;
    }
    if (typeof configStr === "string") {
      configFile = "/config";
      TessModule.FS.writeFile(configFile, configStr);
    }

    api = new TessModule.TessBaseAPI();
    api.Init(null, langs, oem, configFile);
    params = defaultParams;
    await setParameters({ payload: { params } });
    res.progress({
      workerId, status: 'initialized api', progress: 1,
    });
    res.resolve();
  } catch (err) {
    res.reject(err.toString());
  }
};

const getPDFInternal = (title, textonly) => {
  const pdfRenderer = new TessModule.TessPDFRenderer('tesseract-ocr', '/', textonly);
  pdfRenderer.BeginDocument(title);
  pdfRenderer.AddImage(api);
  pdfRenderer.EndDocument();
  TessModule._free(pdfRenderer);

  return TessModule.FS.readFile('/tesseract-ocr.pdf');
};

const getPDF = async ({ payload: { title, textonly } }, res) => {
  res.resolve(getPDFInternal(title, textonly));
};

// Combines default output with user-specified options and
// counts (1) total output formats requested and (2) outputs that require OCR
const processOutput = (output) => {
  const workingOutput = JSON.parse(JSON.stringify(defaultOutput));
  // Output formats were set using `setParameters` in previous versions
  // These settings are copied over for compatability
  if (params.tessjs_create_box === "1") workingOutput.box = true;
  if (params.tessjs_create_hocr === "1") workingOutput.hocr = true;
  if (params.tessjs_create_osd === "1") workingOutput.osd = true;
  if (params.tessjs_create_tsv === "1") workingOutput.tsv = true;
  if (params.tessjs_create_unlv === "1") workingOutput.unlv = true;

  const nonRecOutputs = ["imageColor", "imageGrey", "imageBinary"];
  let recOutputCount = 0;
  for (const prop in output) {
    workingOutput[prop] = output[prop];
  }
  for (const prop in workingOutput) {
    if (workingOutput[prop]) {
      if (!nonRecOutputs.includes(prop)) {
        recOutputCount++;
      }
    }
  }
  return {workingOutput, recOutputCount}
}

// List of options for Tesseract.js (rather than passed through to Tesseract),
// not including those with prefix "tessjs_"
const tessjsOptions = ["rectangle", "pdfTitle", "pdfTextOnly", "rotateAuto", "rotateRadians"];

const recognize = async ({
  payload: {
    image, options, output
  },
}, res) => {
  try {
    const optionsTess = {};
    if (typeof options === "object" && Object.keys(options).length > 0) {
      // The options provided by users contain a mix of options for Tesseract.js
      // and parameters passed through to Tesseract. 
      for (const param in options) {
        if (!param.startsWith('tessjs_') && !tessjsOptions.includes(param)) {
          optionsTess[param] = options[param];
        }
      }
      if (Object.keys(optionsTess).length > 0) {
        api.SaveParameters();
        for (const prop in optionsTess) {
          api.SetVariable(prop, optionsTess[prop]);
        }
      }
    }

    const {workingOutput, recOutputCount} = processOutput(output);

    // When the auto-rotate option is True, setImage is called with no angle,
    // then the angle is calculated by Tesseract and then setImage is re-called.
    // Otherwise, setImage is called once using the user-provided rotateRadiansFinal value.
    let ptr;
    let rotateRadiansFinal;
    if (options.rotateAuto) {
      // The angle is only detected if auto page segmentation is used
      // Therefore, if this is not the mode specified by the user, it is enabled temporarily here
      const psmInit = api.GetPageSegMode();
      let psmEdit = false;
      if (![PSM.AUTO, PSM.AUTO_ONLY, PSM.OSD].includes(psmInit)) {
        psmEdit = true;
        api.SetVariable('tessedit_pageseg_mode', String(PSM.AUTO));
      }

      ptr = setImage(TessModule, api, image);
      api.FindLines();
      const rotateRadiansCalc = api.GetAngle();

      // Restore user-provided PSM setting
      if (psmEdit) {
        api.SetVariable('tessedit_pageseg_mode', String(psmInit));
      }

      // Small angles (<0.005 radians/~0.3 degrees) are ignored to save on runtime
      if (Math.abs(rotateRadiansCalc) >= 0.005) {
        rotateRadiansFinal = rotateRadiansCalc;
        ptr = setImage(TessModule, api, image, rotateRadiansFinal);
      } else {
        // Image needs to be reset if run with different PSM setting earlier
        if (psmEdit) {
          ptr = setImage(TessModule, api, image);
        }
        rotateRadiansFinal = 0;
      }
    } else {
      rotateRadiansFinal = options.rotateRadians || 0;
      ptr = setImage(TessModule, api, image, rotateRadiansFinal);
    }

    const rec = options.rectangle;
    if (typeof rec === 'object') {
      api.SetRectangle(rec.left, rec.top, rec.width, rec.height);
    }

    if (recOutputCount > 0) {
      api.Recognize(null);
    } else {
      log(`Skipping recognition: all output options requiring recognition are disabled.`);
    }
    const pdfTitle = options.pdfTitle;
    const pdfTextOnly = options.pdfTextOnly;
    const result = dump(TessModule, api, workingOutput, {pdfTitle, pdfTextOnly});
    result.rotateRadians = rotateRadiansFinal;

    if (Object.keys(optionsTess).length > 0) {
      api.RestoreParameters();
    }

    res.resolve(result);
    TessModule._free(ptr);
  } catch (err) {
    res.reject(err.toString());
  }
};


const detect = async ({ payload: { image } }, res) => {
  try {
    const ptr = setImage(TessModule, api, image);
    const results = new TessModule.OSResults();

    if (!api.DetectOS(results)) {
      TessModule._free(ptr);

      res.resolve({
        tesseract_script_id: null,
        script: null,
        script_confidence: null,
        orientation_degrees: null,
        orientation_confidence: null,
      });
    } else {
      const best = results.best_result;
      const oid = best.orientation_id;
      const sid = best.script_id;

      TessModule._free(ptr);

      res.resolve({
        tesseract_script_id: sid,
        script: results.unicharset.get_script_from_script_id(sid),
        script_confidence: best.sconfidence,
        orientation_degrees: [0, 270, 180, 90][oid],
        orientation_confidence: best.oconfidence,
      });
    }
  } catch (err) {
    res.reject(err.toString());
  }
};

const terminate = async (_, res) => {
  try {
    if (api !== null) {
      api.End();
    }
    res.resolve({ terminated: true });
  } catch (err) {
    res.reject(err.toString());
  }
};

/**
 * dispatchHandlers
 *
 * @name dispatchHandlers
 * @function worker data handler
 * @access public
 * @param {object} data
 * @param {string} data.jobId - unique job id
 * @param {string} data.action - action of the job, only recognize and detect for now
 * @param {object} data.payload - data for the job
 * @param {function} send - trigger job to work
 */
exports.dispatchHandlers = (packet, send) => {
  const res = (status, data) => {
    send({
      ...packet,
      status,
      data,
    });
  };
  res.resolve = res.bind(this, 'resolve');
  res.reject = res.bind(this, 'reject');
  res.progress = res.bind(this, 'progress');

  latestJob = res;

  ({
    load,
    FS,
    loadLanguage,
    initialize,
    setParameters,
    recognize,
    getPDF,
    detect,
    terminate,
  })[packet.action](packet, res)
    .catch((err) => res.reject(err.toString()));
};

/**
 * setAdapter
 *
 * @name setAdapter
 * @function
 * @access public
 * @param {object} adapter - implementation of the worker, different in browser and node environment
 */
exports.setAdapter = (_adapter) => {
  adapter = _adapter;
};
