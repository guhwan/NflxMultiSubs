const console = require('./console');
const JSZip = require('jszip');
const kDefaultSettings = require('./default-settings');
const PlaybackRateController = require('./playback-rate-controller');

////////////////////////////////////////////////////////////////////////////////

// Hook JSON.parse() and attempt to intercept the manifest
// For cadmium-playercore-6.0022.710.042.js and later
const hookJsonParseAndAddCallback = function (_window) {
  const _parse = JSON.parse;
  _window.JSON.parse = (...args) => {
    const result = _parse.call(JSON, ...args);
    if (result && result.result && result.result.movieId) {
      const movieId = result.result.movieId;
      window.__NflxMultiSubs.updateManifest(result.result);
    }
    return result;
  };
};
hookJsonParseAndAddCallback(window);


// hook `history.pushState()` as there is not "pushstate" event in DOM API
// Because Netflix preload manifests when the user hovers mouse over movies on index page,
// our .updateManifest() won't be trigger after user clicks a movie to start watching (they must reload the player page)
(() => {
  function processStateChange() {
    const movieIdInUrl = extractMovieIdFromUrl();
    if (!movieIdInUrl) return;
    console.log(`Movie changed, movieId: ${movieIdInUrl}`);
    nflxMultiSubsManager.activateManifest(movieIdInUrl);
  }

  history.pushState = (f => function pushState(state, ...args) {
    f.call(history, state, ...args);

    processStateChange()
  })(history.pushState);

  // Sometimes the URL captured by pushState does not contain the correct movieId, causing the manifest activation to fail.
  // This happens when there is a server-side redirect after starting playback, which doesn't trigger the pushState hook.
  // For example, a redirect happens after you click on a show thumbnail to start it instead of the play icon.
  // So we also hook history.replaceState to capture this redirect.
  history.replaceState = (f => function replaceState(state, ...args) {
    f.call(history, state, ...args);

    processStateChange()
  })(history.replaceState);
})();

////////////////////////////////////////////////////////////////////////////////

// global states
let gSubtitles = [],
  gSubtitleMenu;
let gMsgPort, gRendererLoop;
let gVideoRatio = 1080 / 1920;
let gRenderOptions = Object.assign({}, kDefaultSettings);
let gSecondaryOffset = 0; // used to move secondary subs if primary subs overflow the screen edge
const extensionId = document.currentScript.id;

function getMsgPort() {
  if (gMsgPort) return gMsgPort;

  if (BROWSER !== 'safari') {
    gMsgPort = chrome.runtime.connect(extensionId);
  }
  else {
    gMsgPort = browser.runtime.connect(extensionId);
  }
  console.log(`Linked: ${extensionId}`);

  gMsgPort.onMessage.addListener(msg => {
    if (!msg.settings) return;
    gRenderOptions = Object.assign({}, msg.settings);
    gRendererLoop && gRendererLoop.setRenderDirty();
    console.log("Updated settings: ", gRenderOptions);
  });

  // This is a workaround for manifest v3.
  // When the service worker is killed and disconnects, we force it to reopen so we can keep receiving setting updates from settings popup.
  gMsgPort.onDisconnect.addListener(() => {
    gMsgPort = null;
    console.debug(`Reconnecting port...`);
    getMsgPort();
  });

  return gMsgPort;
}

// connect with background script immediately to capture settings
if (BROWSER !== 'firefox') {
  try {
    getMsgPort();
  } catch (err) {
    console.warn('Error: cannot talk to background,', err);
  }
}

// Firefox: this injected agent cannot talk to extension directly, thus the
// connection (for applying settings) is relayed by our content script through
// window.postMessage().

if (BROWSER === 'firefox') {
  window.addEventListener(
    'message',
    evt => {
      if (!evt.data || evt.data.namespace !== 'nflxmultisubs') return;

      if (evt.data.action === 'apply-settings' && evt.data.settings) {
        gRenderOptions = Object.assign({}, evt.data.settings);
        gRendererLoop && gRendererLoop.setRenderDirty();
      }
    },
    false
  );

  try {
    window.postMessage({
      namespace: 'nflxmultisubs',
      action: 'connect'
    }, '*');
  } catch (err) {
    console.warn('Error: cannot talk to background,', err);
  }
}

////////////////////////////////////////////////////////////////////////////////

class SubtitleBase {
  constructor(lang, bcp47, urls, isCaption) {
    this.state = 'GENESIS';
    this.active = false;
    this.lang = lang;
    this.bcp47 = bcp47;
    this.isCaption = isCaption;
    this.urls = urls;
    this.extentWidth = undefined;
    this.extentHeight = undefined;
    this.lines = undefined;
    this.lastRenderedIds = undefined;
  }

  activate(options) {
    return new Promise((resolve, reject) => {
      this.active = true;
      if (this.state === 'GENESIS') {
        this.state = 'LOADING';
        console.log(`Subtitle "${this.lang}" downloading`);
        this._download().then(() => {
          this.state = 'READY';
          console.log(`Subtitle "${this.lang}" loaded`);
          resolve(this);
        });
      }
    });
  }

  deactivate() {
    this.active = false;
  }

  render(seconds, options, forced) {
    if (!this.active || this.state !== 'READY' || !this.lines) return [];
    const lines = this.lines.filter(
      line => line.begin <= seconds && seconds <= line.end
    );
    const ids = lines
      .map(line => line.id)
      .sort()
      .toString();

    if (this.lastRenderedIds === ids && !forced) return null;
    this.lastRenderedIds = ids;
    return this._render(lines, options);
  }

  getExtent() {
    return [this.extentWidth, this.extentHeight];
  }

  setExtent(width, height) {
    [this.extentWidth, this.extentHeight] = [width, height];
  }

  _download() {
    if (!this.urls) return Promise.resolve();

    console.debug('Selecting fastest server, candidates: ',
      this.urls.map(u => u.substr(0, 24)));

    return Promise.any(
      this.urls.map(url => fetch(url, { method: 'HEAD' }))
    ).then(r => {
      const url = r.url;
      console.debug(`Fastest: ${url.substr(0, 24)}`);
      return this._extract(fetch(url));
    });
  }

  _render(lines, options) {
    // implemented in derived class
  }

  _extract(fetchPromise) {
    // extract contents downloaded from fetch()
    // implemented in derived class
  }
}

class DummySubtitle extends SubtitleBase {
  constructor() {
    super('Off');
  }

  activate() {
    this.active = true;
    return Promise.resolve();
  }
}

// subtitle with no download urls
class DehydratedSubtitle extends SubtitleBase {
  constructor(...args) {
    super(...args);
  }

  activate() {
    this.active = true;
    return Promise.resolve();
  }
}

class TextSubtitle extends SubtitleBase {
  constructor(...args) {
    super(...args);
  }

  _extract(fetchPromise) {
    return new Promise((resolve, reject) => {
      fetchPromise
        .then(r => r.text())
        .then(xmlText => {
          const xml = new DOMParser().parseFromString(xmlText, 'text/xml');

          const LINE_SELECTOR = 'tt > body > div > p';
          const lines = [].map.call(
            xml.querySelectorAll(LINE_SELECTOR),
            (line, id) => {
              let text = '';
              let extractTextRecur = parentNode => {
                [].forEach.call(parentNode.childNodes, node => {
                  if (node.nodeType === Node.ELEMENT_NODE)
                    if (node.nodeName.toLowerCase() === 'br') text += '\n';
                    else extractTextRecur(node);
                  else if (node.nodeType === Node.TEXT_NODE)
                    text += node.nodeValue + ' ';
                });
              };
              extractTextRecur(line);

              // convert microseconds to seconds
              const begin = parseInt(line.getAttribute('begin')) / 10000000;
              const end = parseInt(line.getAttribute('end')) / 10000000;
              return { id, begin, end, text };
            }
          );

          this.lines = lines;
          resolve();
        });
    });
  }

  _render(lines, options) {
    // these magic numbers looks good on my screen XD
    const fontSize = Math.ceil(this.extentHeight / 30);

    // .join('\n').split('\n') seems redundant but it's done because speaker-based captions will not contain a \n to
    // indicate line breaks, instead they will come as individual elements in the lines array. Regular captions will
    // come as a single element with a \n. So this is to make sure all caption formats are split into lines correctly.
    const textContent = lines.map(line => line.text).join('\n').split('\n');
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttributeNS(null, 'text-anchor', 'middle');
    text.setAttributeNS(null, 'alignment-baseline', 'hanging');
    text.setAttributeNS(null, 'dominant-baseline', 'hanging'); // firefox
    text.setAttributeNS(null, 'paint-order', 'stroke');
    text.setAttributeNS(null, 'stroke', 'black');
    text.setAttributeNS(
      null,
      'stroke-width',
      `${1.0 * options.secondaryTextStroke}px`
    );
    text.setAttributeNS(null, 'x', this.extentWidth * 0.5);
    text.setAttributeNS(
      null,
      'y',
      this.extentHeight * (options.lowerBaselinePos + 0.01)
    );
    text.setAttributeNS(null, 'opacity', options.secondaryTextOpacity);
    text.style.fontSize = `${fontSize * options.secondaryTextScale}px`;
    text.style.fontFamily = 'Arial, Helvetica';
    text.style.fill = options.secondaryTextColor;
    text.style.stroke = 'black';

    // tspan for line breaks
    textContent.forEach((line, i) => {
      const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      tspan.setAttributeNS(null, 'x', this.extentWidth * 0.5);
      if (i > 0) tspan.setAttributeNS(null, 'dy', text.style.fontSize);
      tspan.textContent = line;
      text.appendChild(tspan);
    });

    return [text];
  }
}

class ImageSubtitle extends SubtitleBase {
  constructor(...args) {
    super(...args);
    this.zip = undefined;
  }

  _extract(fetchPromise) {
    return new Promise((resolve, reject) => {
      const unzipP = fetchPromise.then(r => r.blob()).then(zipBlob => new JSZip().loadAsync(zipBlob));
      unzipP.then(zip => {
        zip
          .file('manifest_ttml2.xml')
          .async('string')
          .then(xmlText => {
            const xml = new DOMParser().parseFromString(xmlText, 'text/xml');

            // dealing with `ns2:extent`, `ns3:extent`, ...
            const _getAttributeAnyNS = (domNode, attrName) => {
              const name = domNode.getAttributeNames().find(
                n =>
                  n
                    .split(':')
                    .pop()
                    .toLowerCase() === attrName
              );
              return domNode.getAttribute(name);
            };

            const extent = _getAttributeAnyNS(
              xml.querySelector('tt'),
              'extent'
            );
            [this.extentWidth, this.extentHeight] = extent
              .split(' ')
              .map(n => parseInt(n));

            const _ttmlTimeToSeconds = timestamp => {
              // e.g., _ttmlTimeToSeconds('00:00:06.005') -> 6.005
              const regex = /(\d+):(\d+):(\d+(?:\.\d+)?)/;
              const [hh, mm, sssss] = regex
                .exec(timestamp)
                .slice(1)
                .map(parseFloat);
              return hh * 3600 + mm * 60 + sssss;
            };

            const LINE_SELECTOR = 'tt > body > div';
            const lines = [].map.call(
              xml.querySelectorAll(LINE_SELECTOR),
              (line, id) => {
                const extentAttrName = line.getAttributeNames().find(
                  n =>
                    n
                      .split(':')
                      .pop()
                      .toLowerCase() === 'extent'
                );

                const [width, height] = _getAttributeAnyNS(line, 'extent')
                  .split(' ')
                  .map(n => parseInt(n));
                const [left, top] = _getAttributeAnyNS(line, 'origin')
                  .split(' ')
                  .map(n => parseInt(n));
                const imageName = line
                  .querySelector('image')
                  .getAttribute('src');
                const begin = _ttmlTimeToSeconds(line.getAttribute('begin'));
                const end = _ttmlTimeToSeconds(line.getAttribute('end'));
                return { id, width, height, top, left, imageName, begin, end };
              }
            );

            this.lines = lines;
            this.zip = zip;
            resolve();
          });
      });
    });
  }

  _render(lines, options) {
    const scale = options.secondaryImageScale;
    const centerLine = this.extentHeight * 0.5;
    const upperBaseline = this.extentHeight * options.upperBaselinePos;
    const lowerBaseline = this.extentHeight * options.lowerBaselinePos;
    return lines.map(line => {
      const img = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'image'
      );
      this.zip
        .file(line.imageName)
        .async('blob')
        .then(blob => {
          const { left, top, width, height } = line;
          const [newWidth, newHeight] = [width * scale, height * scale];
          const newLeft = left + 0.5 * (width - newWidth);
          const newTop = top <= centerLine ? upperBaseline + gSecondaryOffset : lowerBaseline;

          const src = URL.createObjectURL(blob);
          img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', src);
          img.setAttributeNS(null, 'width', newWidth);
          img.setAttributeNS(null, 'height', newHeight);
          img.setAttributeNS(null, 'x', newLeft);
          img.setAttributeNS(null, 'y', newTop);
          img.setAttributeNS(null, 'opacity', options.secondaryImageOpacity);
          img.addEventListener('load', () => {
            URL.revokeObjectURL(src);
          });
        });
      return img;
    });
  }
}

// -----------------------------------------------------------------------------

class SubtitleFactory {
  // track: manifest.textTracks[...]
  static build(track) {
    const isImageBased = Object.values(track.ttDownloadables).some(d => d.isImage);
    const isCaption = track.rawTrackType === 'closedcaptions';
    const lang = track.languageDescription + (isCaption ? ' [CC]' : '');
    const bcp47 = track.language;

    if (!track.hydrated) {
      return new DehydratedSubtitle(lang, bcp47);
    }
    if (isImageBased) {
      return this._buildImageBased(track, lang, bcp47, isCaption);
    }
    return this._buildTextBased(track, lang, bcp47, isCaption);
  }

  static isNoneTrack(track) {
    // Sometimes Netflix places "fake" text tracks into manifests.
    // Such tracks have "isNoneTrack: false" and even have downloadable URLs,
    // while their display name is "Off" (localized in UI language, e.g., "關閉").
    // Here we use a huristic rule concluded by observation to filter those "fake" tracks out.
    if (track.isNoneTrack) {
      return true;
    }

    // "new_track_id" example "T:1:0;1;zh-Hant;1;1;"
    // the last bit is 1 for NoneTrack text tracks
    try {
      const isNoneTrackBit = track.new_track_id.split(';')[4];
      if (isNoneTrackBit === '1') {
        return true;
      }
    }
    catch (err) {
    }

    // "rank" === -1
    if (track.rank !== undefined && track.rank < 0) {
      return true;
    }
    return false;
  }

  static _buildImageBased(track, lang, bcp47, isCaption) {
    const maxHeight = Math.max(...Object.values(track.ttDownloadables).map(d => {
      if (d.height)
        return d.height;
      else
        return -1;
    }));
    const d = Object.values(track.ttDownloadables).find(d => d.height === maxHeight);
    let urls;
    if (d.downloadUrls) {
      urls = Object.values(d.downloadUrls);
    } else {
      urls = d.urls.map(t => t.url);
    }
    return new ImageSubtitle(lang, bcp47, urls, isCaption);
  }

  static _buildTextBased(track, lang, bcp47, isCaption) {
    const targetProfile = 'dfxp-ls-sdh';
    const d = track.ttDownloadables[targetProfile];
    if (!d) {
      console.debug(`Cannot find "${targetProfile}" for ${lang}`);
      return null;
    }
    let urls;
    if (d.downloadUrls) {
      urls = Object.values(d.downloadUrls);
    } else {
      urls = d.urls.map(t => t.url);
    }
    return new TextSubtitle(lang, bcp47, urls, isCaption);
  }
}

// ================= [AI 번역: 스트리밍 & 버퍼링 모드] =================

const AI_API_KEY = "key"; // 본인 키 확인
const MODEL_NAME = "gemini-3-flash-preview";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 진행률 박스 UI 생성 함수
function updateProgressUI(current, total, isComplete = false) {
  let progressBox = document.getElementById('ai-progress-box');
  if (!progressBox) {
    progressBox = document.createElement('div');
    progressBox.id = 'ai-progress-box';
    // 방해되지 않게 반투명하고 작게 디자인
    progressBox.style.cssText = "position: fixed; top: 80px; left: 20px; background: rgba(0, 0, 0, 0.7); color: #fff; padding: 10px 15px; z-index: 9999; border-radius: 8px; font-size: 14px; font-weight: bold; border-left: 4px solid #e50914; pointer-events: none; transition: opacity 0.5s;";
    document.body.appendChild(progressBox);
  }

  const percent = Math.round((current / total) * 100);
  
  if (isComplete) {
    progressBox.innerHTML = `✅ 번역 완료! 즐겁게 감상하세요.`;
    setTimeout(() => { progressBox.style.opacity = 0; }, 5000);
    setTimeout(() => { progressBox.remove(); }, 6000);
  } else {
    progressBox.innerHTML = `
      ⚡ 실시간 번역 중... (${percent}%) <br>
      <span style="font-size:12px; color:#ddd; font-weight:normal;">
        ${current} / ${total} 줄 완료 <br>
        영화 보셔도 됩니다 (앞부분부터 순차 적용됨)
      </span>
    `;
  }
}

// 덩어리(Chunk) 단위로 번역해서 바로바로 적용하는 함수
async function runStreamTranslation(subtitleInstance) {
  const textLines = subtitleInstance.lines;
  if (!textLines || textLines.length === 0) return;

  const CHUNK_SIZE = 50; 
  console.log(`[스트리밍 번역 시작] 총 ${textLines.length}줄`);

  for (let i = 0; i < textLines.length; i += CHUNK_SIZE) {
    // 1. 번역할 덩어리 자르기
    const chunkEnd = Math.min(i + CHUNK_SIZE, textLines.length);
    const chunk = textLines.slice(i, chunkEnd);
    const originalTexts = chunk.map(l => l.text);

    // 2. 프롬프트 (JSON 배열 형식 유지)
    const prompt = `
      Translate these subtitles from English to Korean naturally.
      Context: Netflix Movie.
      Rules:
      1. Keep exactly ${originalTexts.length} lines.
      2. No line numbers.
      3. Keep music/sound effects as is.
      4. Output strictly a JSON array of strings.
      
      Input:
      ${JSON.stringify(originalTexts)}
    `;

    try {
      // 3. API 호출
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${AI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      const data = await response.json();
      
      // 데이터 파싱
      let translatedArray = [];
      try {
        let rawText = data.candidates[0].content.parts[0].text;
        rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        translatedArray = JSON.parse(rawText);
      } catch (e) {
        // 파싱 실패시 줄바꿈으로 시도
        console.warn(`Chunk ${i} JSON 파싱 실패, 텍스트 모드로 대체`);
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        translatedArray = rawText.split('\n').filter(t => t.trim());
      }

      // 4. [핵심] 영문 + 한글 합치기 (Dual Subtitle Logic)
      for (let j = 0; j < chunk.length; j++) {
        if (translatedArray[j]) {
          const original = originalTexts[j].replace(/\n/g, ' '); // 영문 내 불필요한 줄바꿈 제거 (깔끔하게)
          const korean = translatedArray[j];
          
          // ✨ 여기서 합칩니다! (위: 영어 / 아래: 한글)
          subtitleInstance.lines[i + j].text = `${original}\n${korean}`;
        }
      }

      // 5. UI 업데이트
      updateProgressUI(chunkEnd, textLines.length);
      console.log(`[진행률] ${chunkEnd} / ${textLines.length} 완료`);

      // 6. 넷플릭스가 변경된 자막을 다시 그리도록 강제 리프레시 신호
      // (RendererLoop가 dirty flag를 확인하게 함)
      if (window.__NflxMultiSubs && window.__NflxMultiSubs.rendererLoop) {
         // 이 부분은 외부에서 접근이 어려울 수 있으므로, 
         // 단순히 자막 텍스트만 바꿔두면 다음 프레임 렌더링 때 자동 반영됩니다.
      }

      // API 속도 제한 고려 (0.3초 대기)
      await delay(800);

    } catch (error) {
      console.error(`Chunk ${i} 번역 실패 (원문 유지):`, error);
      // 실패해도 멈추지 않고 다음 덩어리로 넘어감
    }
  }

  updateProgressUI(textLines.length, textLines.length, true);
  console.log("모든 번역 완료!");
}

class AiTranslatedSubtitle extends TextSubtitle {
  constructor(lang, bcp47, urls, isCaption) {
    super(lang, bcp47, urls, isCaption);
    this.isAi = true;
  }

  // 데이터 다운로드 및 파싱
  _extract(fetchPromise) {
    // 1. 부모 클래스의 _extract를 호출하여 '영어 자막'을 먼저 다 로드함.
    return super._extract(fetchPromise).then(() => {
      
      // 2. 로드가 끝나면 바로 '준비 완료(READY)' 상태가 되어 화면에 영어가 뜸.
      console.log("영어 자막 로드 완료. 백그라운드 번역 시작...");
      
      // 3. [중요] await 없이 비동기로 번역 함수를 실행 (Fire and Forget)
      // 이렇게 해야 사용자는 기다리지 않고 바로 영상을 볼 수 있음.
      runStreamTranslation(this); 
      
      // 4. 즉시 Promise를 리턴하여 넷플릭스 플레이어에게 "나 준비됐어!"라고 알림
      return Promise.resolve();
    });
  }
}
// ================= [스트리밍 로직 끝] =================

// textTracks: manifest.textTracks
const buildSubtitleList = textTracks => {
  const dummy = new DummySubtitle();
  dummy.activate();

  const subs = textTracks
    .filter(t => !SubtitleFactory.isNoneTrack(t))
    .map(t => SubtitleFactory.build(t))
    .filter(t => t !== null);

  // [추가된 로직] 영어 자막을 찾아서 'AI 한국어' 트랙으로 복제 생성
  const englishSubTrack = textTracks.find(t => t.language === 'en');
  if (englishSubTrack) {
    // 영어 트랙 정보를 가져와서 AI 클래스로 생성
    const aiSub = new AiTranslatedSubtitle(
      'AI 한국어 (Beta)', // 메뉴에 표시될 이름
      'ko-ai',            // 고유 코드
      Object.values(englishSubTrack.ttDownloadables['dfxp-ls-sdh'].downloadUrls || englishSubTrack.ttDownloadables['dfxp-ls-sdh'].urls.map(u=>u.url)), 
      false
    );
    // 리스트의 맨 앞에 추가 (잘 보이게)
    subs.unshift(aiSub);
  }

  return subs.concat(dummy);
};

// textTracks: manifest.textTracks
const updateSubtitleList = (textTracks, textTrackId) => {
  const track = textTracks.find(t => t.new_track_id == textTrackId),
    sub = SubtitleFactory.build(track),
    index = gSubtitles.findIndex(s => s.lang == sub.lang);
  if (gSubtitles[index] instanceof DehydratedSubtitle && sub !== null) {
    gSubtitles[index] = sub;
    gSubtitleMenu && gSubtitleMenu.render();
  }
};

////////////////////////////////////////////////////////////////////////////////

const SUBTITLE_LIST_CLASSNAME = 'nflxmultisubs-subtitle-list';
const SUB_MENU_SELECTOR = 'selector-audio-subtitle';
class SubtitleMenu {
  constructor(node) {
    this.style = this.extractStyle(node)
    this.elem = document.createElement('div');
    this.elem.classList.add(this.style.maindiv, 'structural', 'track-list-subtitles');
    this.elem.classList.add(SUBTITLE_LIST_CLASSNAME);
  }

  extractStyle(node) {
    // get class names of all the sub menu elements
    // so we can apply them to our menu and copy their style
    const style = { maindiv: null, subdiv: null, h3: null, ul: null, li: null, selected: null }
    const mainNode = node.querySelector(`div[data-uia=${SUB_MENU_SELECTOR}]`)

    if (!mainNode) return style;

    style.maindiv = mainNode.firstChild?.className;
    style.subdiv = mainNode.querySelector('li div div')?.className;
    style.h3 = mainNode.querySelector('h3')?.className;
    style.ul = mainNode.querySelector('ul')?.className;
    style.li = mainNode.querySelector('li')?.className;
    style.selected = mainNode.querySelector('li[data-uia*="selected"] svg')?.className?.baseVal; // Netflix fuckery

    return style
  }

  render() {
    const checkIcon = `<svg viewBox="0 0 24 24" class="${this.style.selected}"><path fill="currentColor" d="M3.707 12.293l-1.414 1.414L8 19.414 21.707 5.707l-1.414-1.414L8 16.586z"></path></svg>`;

    const loadingIcon = `<svg class="${this.style.selected}" focusable="false" viewBox="0 -5 50 55">
          <path d="M 6 25 C6 21, 0 21, 0 25 C0 57, 49 59, 50 25 C50 50, 8 55, 6 25" stroke="transparent" fill="red">
            <animateTransform attributeType="xml" attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="0.9s" repeatCount="indefinite"/>
          </path>
      </svg>`;

    this.elem.innerHTML = `<h3 class="${this.style.h3}">Secondary Subtitles</h3>`;

    const listElem = document.createElement('ul');
    gSubtitles.forEach((sub, id) => {
      if (sub instanceof DehydratedSubtitle) return;
      let item = document.createElement('li');
      item.classList.add(this.style.li);
      if (sub.active) {
        const icon = sub.state === 'LOADING' ? loadingIcon : checkIcon;
        item.classList.add('selected');
        item.innerHTML = `<div>${icon}<div class="${this.style.subdiv}">${sub.lang}</div></div>`;
      } else {
        item.innerHTML = `<div><div class="${this.style.subdiv}">${sub.lang}</div></div>`;
        item.addEventListener('click', () => {
          activateSubtitle(id);
        });
      }
      listElem.classList.add(this.style.ul);
      listElem.appendChild(item);
    });
    const listWrapper = document.createElement('div');
    listWrapper.style.overflowY = 'auto';
    listWrapper.style.overflowX = 'hidden';
    listWrapper.appendChild(listElem);
    this.elem.appendChild(listWrapper);
  }
}

// -----------------------------------------------------------------------------

const isPopupMenuElement = node => {
  return (
    node.nodeName.toLowerCase() === 'div' &&
    node.querySelector(`div[data-uia=${SUB_MENU_SELECTOR}]`)
  );
};

// FIXME: can we disconnect this observer once our menu is injected ?
// we still don't know whether Netflix would re-build the pop-up menu after
// switching to next episodes
const bodyObserver = new MutationObserver(mutations => {
  mutations.forEach(mutation => {
    mutation.addedNodes.forEach(node => {
      if (isPopupMenuElement(node)) {
        // popup menu attached
        if (!node.getElementsByClassName(SUBTITLE_LIST_CLASSNAME).length) {
          if (!gSubtitleMenu) {
            gSubtitleMenu = new SubtitleMenu(node);
            gSubtitleMenu.render();
          }
          node.style.left = "auto";
          node.style.right = "10px";
          node.querySelector(`div[data-uia=${SUB_MENU_SELECTOR}]`).appendChild(gSubtitleMenu.elem);
        }
      }
    });
    mutation.removedNodes.forEach(node => {
      if (isPopupMenuElement(node)) {
        // popup menu detached
      }
    });
  });
});
const observerOptions = {
  attributes: true,
  subtree: true,
  childList: true,
  characterData: true
};
bodyObserver.observe(document.body, observerOptions);

////////////////////////////////////////////////////////////////////////////////

activateSubtitle = id => {
  const sub = gSubtitles[id];
  if (sub) {
    gSubtitles.forEach(sub => sub.deactivate());
    sub.activate().then(() => { gSubtitleMenu && gSubtitleMenu.render(); });

    gRenderOptions.secondaryLanguageLastUsed = sub.bcp47;
    gRenderOptions.secondaryLanguageLastUsedIsCaption = sub.isCaption;

    if (BROWSER !== 'firefox') {
      try {
        getMsgPort().postMessage({ settings: gRenderOptions });
      } catch (err) {
        console.warn('Cannot dispatch settings,', err);
      }
    } else {
      // Firefox
      try {
        window.postMessage({
          namespace: 'nflxmultisubs',
          action: 'update-settings',
          settings: gRenderOptions
        }, '*');
      } catch (err) {
        console.warn('Error: cannot talk to background,', err);
      }
    }
  }
  gSubtitleMenu && gSubtitleMenu.render();
};

const buildSecondarySubtitleElement = options => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('nflxmultisubs-subtitle-svg');
  svg.style =
    'position:absolute; width:100%; top:0; bottom:0; left:0; right:0;';
  svg.setAttributeNS(null, 'width', '100%');
  svg.setAttributeNS(null, 'height', '100%');

  const padding = document.createElement('div');
  padding.classList.add('nflxmultisubs-subtitle-padding');
  padding.style = `display:block; content:' '; width:100%; padding-top:${gVideoRatio *
    100}%;`;

  const container = document.createElement('div');
  container.classList.add('nflxmultisubs-subtitle-container');
  container.style = 'position:relative; width:100%; max-height:100%;';
  container.appendChild(svg);
  container.appendChild(padding);

  const wrapper = document.createElement('div');
  wrapper.classList.add('nflxmultisubs-subtitle-wrapper');
  wrapper.style =
    'position:absolute; top:0; left:0; width:100%; height:100%; z-index:2; display:flex; align-items:center;';
  wrapper.appendChild(container);
  return wrapper;
};

// -----------------------------------------------------------------------------

class PrimaryImageTransformer {
  constructor() { }

  transform(svgElem, controlsActive, forced) {
    const selector = forced ? 'image' : 'image:not(.nflxmultisubs-scaled)';
    const images = svgElem.querySelectorAll(selector);
    if (images.length > 0) {
      const viewBox = svgElem.getAttributeNS(null, 'viewBox');
      const [extentWidth, extentHeight] = viewBox
        .split(' ')
        .slice(-2)
        .map(n => parseInt(n));

      // TODO: if there's no secondary subtitle, center the primary on baseline
      const options = gRenderOptions;
      const centerLine = extentHeight * 0.5;
      const upperBaseline = extentHeight * options.upperBaselinePos;
      const lowerBaseline = extentHeight * options.lowerBaselinePos;
      const scale = options.primaryImageScale;
      const opacity = options.primaryImageOpacity;
      const color = options.primaryTextColor;

      [].forEach.call(images, img => {
        img.classList.add('nflxmultisubs-scaled');
        const left = parseInt(
          img.getAttributeNS(null, 'data-orig-x') ||
          img.getAttributeNS(null, 'x')
        );
        const top = parseInt(
          img.getAttributeNS(null, 'data-orig-y') ||
          img.getAttributeNS(null, 'y')
        );
        const width = parseInt(
          img.getAttributeNS(null, 'data-orig-width') ||
          img.getAttributeNS(null, 'width')
        );
        const height = parseInt(
          img.getAttributeNS(null, 'data-orig-height') ||
          img.getAttributeNS(null, 'height')
        );

        const attribs = [
          ['x', left],
          ['y', top],
          ['width', width],
          ['height', height]
        ];
        attribs.forEach(p => {
          const attrName = `data-orig-${p[0]}`,
            attrValue = p[1];
          if (!img.getAttributeNS(null, attrName)) {
            img.setAttributeNS(null, attrName, attrValue);
          }
        });

        const [newWidth, newHeight] = [width * scale, height * scale];
        const newLeft = left + 0.5 * (width - newWidth);

        // large scale multi-line subs sometimes fall outside of the screen when they are placed at the top,
        // caused by newTop becoming negative (because newHeight is based on the subs scale)
        // subtracting newHeight/2 prevents this and makes it so that multiline subs are displayed at roughly
        // the same location as the single line subs when this happens.
        // gSecondaryOffset moves the secondary subtitles with it
        let newTop;

        if (top <= centerLine) {
          if (upperBaseline - newHeight <= 0) {
            newTop = upperBaseline - newHeight / 2
            gSecondaryOffset = newHeight / 2
          } else {
            newTop = upperBaseline - newHeight
            gSecondaryOffset = 0
          }
        } else {
          newTop = lowerBaseline - newHeight
          gSecondaryOffset = 0
        }

        // if it somehow still ends up negative just hard-constrain it
        // (we arbitrarily choose 10 to give it some space from the screen edge)
        newTop = (newTop <= 0) ? 10 : newTop;

        img.setAttributeNS(null, 'width', newWidth);
        img.setAttributeNS(null, 'height', newHeight);
        img.setAttributeNS(null, 'x', newLeft);
        img.setAttributeNS(null, 'y', newTop);
        img.setAttributeNS(null, 'opacity', opacity);
        img.setAttributeNS(null, 'color', color);
      });
    }
  }
}

class PrimaryTextTransformer {
  constructor() {
    this.lastScaledPrimaryTextContent = undefined;
  }

  transform(divElem, controlsActive, forced) {
    let parentNode = divElem.parentNode;
    if (!parentNode.classList.contains('nflxmultisubs-primary-wrapper')) {
      // let's use `<style>` + `!imporant` to outrun the offical player...
      const wrapper = document.createElement('div');
      wrapper.classList.add('nflxmultisubs-primary-wrapper');
      wrapper.style =
        'position:absolute; width:100%; height:100%; top:0; left:0;';

      const styleElem = document.createElement('style');
      wrapper.appendChild(styleElem);

      // wrap the offical text-based subtitle container, hehe!
      parentNode.insertBefore(wrapper, divElem);
      wrapper.appendChild(divElem);
      parentNode = wrapper;
    }

    const containers = divElem.querySelectorAll('.player-timedtext-text-container');
    // select all elements to check if there are more than one later
    // but for now we only need the first one to attach our style
    const container = containers.item(0);
    if (!container) return;

    const textContent = container.textContent;
    if (this.lastScaledPrimaryTextContent === textContent && !forced) return;
    this.lastScaledPrimaryTextContent = textContent;

    const style = parentNode.querySelector('style');
    if (!style) return;

    const textSpan = Array.from(container.querySelectorAll('span'));
    if (!textSpan) return;

    const fontSize = parseInt(textSpan.find(t => t.style.fontSize).style.fontSize);
    if (!fontSize) return;

    const options = gRenderOptions;
    const opacity = options.primaryTextOpacity;
    const color = options.primaryTextColor;
    const scale = options.primaryTextScale;
    const newFontSize = fontSize * scale;
    const styleText = `.player-timedtext-text-container span {
        font-size: ${newFontSize}px !important;
        opacity: ${opacity};
        color: ${color} !important;
      }`;
    style.textContent = styleText;

    const rect = divElem.getBoundingClientRect();
    const [extentWidth, extentHeight] = [rect.width, rect.height];

    const lowerBaseline = extentHeight * options.lowerBaselinePos;
    const { left, top, width, height } = container.getBoundingClientRect();
    const newLeft = extentWidth * 0.5 - width * 0.5;
    let newTop = lowerBaseline - height;

    // FIXME: dirty transform & magic offets
    // we out run the official player, so the primary text-based subtitles
    // does not move automatically when the navs are active
    newTop += controlsActive ? -100 : 0;

    if (containers.length == 1) {
      style.textContent +=
        styleText +
        '\n' +
        `
      .player-timedtext-text-container {
        top: ${newTop}px !important;
        left: ${newLeft}px !important;
      }`;
    } else {
      // Don't change position when there are multiple subtitle boxes.
      // Changing 'left:' will cause overlap.
      // This can happen for subs that have speaker-placed captioning enabled (subs that are positioned over the speaker)
    }
  }
}

class RendererLoop {
  constructor(video) {
    this.isRunning = false;
    this.isRenderDirty = undefined; // windows resize or config change, force re-render
    this.videoElem = video;
    this.subtitleWrapperElem = undefined; // secondary subtitles wrapper (outer)
    this.subSvg = undefined; // secondary subtitles container
    this.primaryImageTransformer = new PrimaryImageTransformer();
    this.primaryTextTransformer = new PrimaryTextTransformer();
  }

  setRenderDirty() {
    this.isRenderDirty = true;
  }

  start() {
    this.isRunning = true;
    window.requestAnimationFrame(this.loop.bind(this));
    if (BROWSER !== 'firefox') {
      try {
        getMsgPort().postMessage({ startPlayback: 1 });
      } catch (err) {
        console.warn('Cannot dispatch start playback,', err);
      }
    } else {
      // Firefox
      try {
        window.postMessage({
          namespace: 'nflxmultisubs',
          action: 'startPlayback'
        }, '*');
      } catch (err) {
        console.warn('Error: cannot talk to background,', err);
      }
    }
  }

  stop() {
    this.isRunning = false;
    this._clearSecondarySubtitles();
    if (BROWSER !== 'firefox') {
      try {
        getMsgPort().postMessage({ stopPlayback: 1 });
      }
      catch (err) {
        console.warn('Cannot dispatch stop playback,', err);
      }
    } else {
      // Firefox
      try {
        window.postMessage({
          namespace: 'nflxmultisubs',
          action: 'stopPlayback'
        }, '*');
      } catch (err) {
        console.warn('Error: cannot talk to background,', err);
      }
    }
  }

  loop() {
    try {
      this._loop();
      this.isRunning && window.requestAnimationFrame(this.loop.bind(this));
    }
    catch (err) {
      console.error('Fatal: ', err);
    }
  }

  _loop() {
    const currentVideoElem = document.querySelector('#appMountPoint video');

    // stop the render loop if there is no videoplayer (e.g.: user is on the homepage)
    if (!currentVideoElem && !/netflix\..*\/watch/i.test(window.location.href)) {
      this.stop();
      window.__NflxMultiSubs.lastMovieId = undefined // clear this in case the same show is started again later
      return;
    }

    if (currentVideoElem && this.videoElem.src !== currentVideoElem.src) {
      // TODO: do we still need to check for this?
      // some video change episodes by update video src
      // force terminate renderer loop if src changed
      this.stop();
      window.__NflxMultiSubs.rendererLoopDestroy();
      return;
    }

    const controlsActive = this._getControlsActive();
    // NOTE: don't do this, the render rate is too high to shown the
    // image in SVG for secondary subtitles.... O_Q
    // if (controlsActive) {
    //   this.setRenderDirty(); // to move up subttles
    // }
    if (!this._appendSubtitleWrapper()) {
      return;
    }

    this._adjustPrimarySubtitles(controlsActive, !!this.isRenderDirty);
    this._renderSecondarySubtitles();

    // render secondary subtitles
    // ---------------------------------------------------------------------
    // FIXME: dirty transform & magic offets
    // this leads to a big gap between primary & secondary subtitles
    // when the progress bar is shown
    this.subtitleWrapperElem.style.top = controlsActive ? '-100px' : '0';

    // everything rendered, clear the dirty bit with ease
    this.isRenderDirty = false;
  }

  _getControlsActive() {
    // FIXME: better solution to handle different versions of Netflix web player UI
    // "Neo Style" refers to the newer version as in 2018/07
    let controlsElem = document.querySelector('.controls, div[data-uia="controls-standard"], .watch-video--bottom-controls-container'),
      neoStyle = false;
    if (!controlsElem) {
      controlsElem = document.querySelector('.PlayerControlsNeo__layout');
      if (!controlsElem) {
        return false;
      }
      neoStyle = true;
    }
    // elevate the navs' z-index (to be on top of our subtitles)
    if (!controlsElem.style.zIndex) {
      controlsElem.style.zIndex = 3;
    }

    if (neoStyle) {
      return !controlsElem.classList.contains(
        'PlayerControlsNeo__layout--inactive'
      );
    }
    return controlsElem !== null;
  }

  // @returns {boolean} Successed?
  _appendSubtitleWrapper() {
    if (!this.subtitleWrapperElem || !this.subtitleWrapperElem.parentNode) {
      const playerContainerElem = document.querySelector('div[data-uia="video-canvas"]');
      if (!playerContainerElem) return false;
      this.subtitleWrapperElem = buildSecondarySubtitleElement(gRenderOptions);
      playerContainerElem.appendChild(this.subtitleWrapperElem);
    }
    return true;
  }

  // transform & scale primary subtitles
  _adjustPrimarySubtitles(active, dirty) {
    // NOTE: we cannot put `primaryImageSubSvg` into instance state,
    // because there are multiple instance of the SVG and they're switched
    // when the langauge of primary subtitles is switched.
    const force = this.lastControlsActive !== active;
    const primaryImageSubSvg = document.querySelector(
      '.image-based-subtitles svg'
    );
    if (primaryImageSubSvg) {
      this.primaryImageTransformer.transform(primaryImageSubSvg, active, dirty || force);
    }

    const primaryTextSubDiv = document.querySelector('.player-timedtext');
    if (primaryTextSubDiv) {
      this.primaryTextTransformer.transform(primaryTextSubDiv, active, dirty || force);
    }

    this.lastControlsActive = active;
  }

  _clearSecondarySubtitles() {
    if (!this.subSvg || !this.subSvg.parentNode) return;
    [].forEach.call(this.subSvg.querySelectorAll('*'), elem =>
      elem.parentNode.removeChild(elem));
  }

  _renderSecondarySubtitles() {
    if (!this.subSvg || !this.subSvg.parentNode) {
      this.subSvg = this.subtitleWrapperElem.querySelector('svg');
    }
    const seconds = this.videoElem.currentTime;
    const sub = gSubtitles.find(sub => sub.active);
    if (!sub) {
      return;
    }

    if (sub instanceof TextSubtitle) {
      const rect = this.videoElem.getBoundingClientRect();
      sub.setExtent(rect.width, rect.height);
    }

    const renderedElems = sub.render(
      seconds,
      gRenderOptions,
      !!this.isRenderDirty
    );
    if (renderedElems) {
      const [extentWidth, extentHeight] = sub.getExtent();
      if (extentWidth && extentHeight) {
        this.subSvg.setAttribute(
          'viewBox',
          `0 0 ${extentWidth} ${extentHeight}`
        );
      }
      this._clearSecondarySubtitles();
      renderedElems.forEach(elem => this.subSvg.appendChild(elem));
    }
  }
}

window.addEventListener('resize', evt => {
  gRendererLoop && gRendererLoop.setRenderDirty();
  console.log(
    'Resize:',
    `${window.innerWidth}x${window.innerHeight} (${evt.timeStamp})`
  );
});


// -----------------------------------------------------------------------------

class ManifestManagerBase {
  enumManifest() { }
  getManifest(movieId) { }
  saveManifest(manifest) { }
}


class ManifestManagerInMemory extends ManifestManagerBase {
  constructor(...args) {
    super(...args);
    this.manifests = {};
  }

  enumManifest() {
    return this.manifests;
  }

  getManifest(movieId) {
    return this.manifests[movieId];
  }

  saveManifest(manifest) {
    this.manifests[manifest.movieId] = manifest;
  }
}

class ManifestManagerLocalStorage extends ManifestManagerBase {
  enumManifests() {
    return Object.entries(window.localStorage).filter((key, val) => {
      return key.indexOf('manifest=') == 0;
    });
  }

  getManifest(movieId) {
    const key = `manifest=${movieId}`;
    const item = window.localStorage.getItem(key);
    if (!item) {
      console.log(`Manifet ${movieId} not found in localStorage`);
      return null;
    }

    const manifest = JSON.parse(item).manifest;
    return manifest;
  }

  saveManifest(manifest) {
    const key = `manifest=${manifest.movieId}`;
    window.localStorage.setItem(key, JSON.stringify({
      manifest: manifest,
      timestamp: new Date(),
    }));
  }
}



const extractMovieIdFromUrl = () => {
  const isInPlayerPage = /netflix\.com\/watch/i.test(window.location.href);
  if (!isInPlayerPage) {
    return null;
  }

  try {
    const movieIdInUrl = /^\/watch\/(\d+)/.exec(window.location.pathname)[1];
    const movieId = parseInt(movieIdInUrl);
    return movieId;
  }
  catch (err) {
    console.error(err);
  }
  return null;
};

class NflxMultiSubsManager {
  constructor() {
    this.version = VERSION;
    this.lastMovieId = undefined;
    this.playerUrl = undefined;
    this.playerVersion = undefined;
    this.busyWaitTimeout = 100000; // ms
    this.manifestManager = new ManifestManagerInMemory();
    console.log(`Version: ${this.version}`)
  }

  busyWaitVideoElement() {
    // Never reject
    return new Promise((resolve, _) => {
      let timer = 0;
      const intervalId = setInterval(() => {
        const video = document.querySelector('#appMountPoint video');
        if (video) {
          clearInterval(intervalId);
          resolve(video);
        }
        if (timer * 200 === this.busyWaitTimeout) {
          // Notify user can F5 or just keep wait...
          clearInterval(intervalId);
        }
        timer += 1;
      }, 200);
    });
  }

  activateManifest(movieId) {
    const manifest = this.manifestManager.getManifest(movieId);
    if (!manifest) {
      console.log(`Cannot find manifest: ${movieId}`);
      return;
    }

    const movieIdInUrl = extractMovieIdFromUrl();
    if (!movieIdInUrl) return;

    if (movieIdInUrl != manifest.movieId) {
      console.log(`Different manifest, movieIdInUrl=${movieIdInUrl}, manifest.movieId=${manifest.movieId}`);
      return;
    }

    // Sometime the movieId in URL may be different to the actually playing manifest
    // Thus we also need to check the player DOM tree...
    this.busyWaitVideoElement()
      .then(video => {
        try {
          const movieIdInUrl = extractMovieIdFromUrl();
          let playingManifest = (manifest.movieId === movieId);

          if (!playingManifest) {
            // magic! ... div.VideoContainer > div#12345678 > video[src=blob:...]
            const movieIdInPlayerNode = video.parentNode.id;
            console.log(`Note: movieIdInPlayerNode=${movieIdInPlayerNode}`);
            playingManifest = movieIdInPlayerNode.includes(manifest.movieId.toString());
          }

          if (!playingManifest) {
            console.log(`Ignored: manifest ${manifest.movieId} not playing`);
            // Ignore but store it.
            // this.manifestList.push(manifest);
            return;
          }

          const movieChanged = manifest.movieId !== this.lastMovieId;
          if (!movieChanged) {
            updateSubtitleList(manifest.timedtexttracks, manifest.recommendedMedia.timedTextTrackId);
            console.log(`Manifest ${manifest.movieId} updated`);
            return;
          }

          console.log(`Activating manifest ${manifest.movieId} (last=${this.lastMovieId})`);
          this.lastMovieId = manifest.movieId;

          // For cadmium-playercore-6.0012.183.041.js and later
          gSubtitles = buildSubtitleList(manifest.timedtexttracks);

          // select subtitle based on language settings
          console.log('Language mode: ', gRenderOptions.secondaryLanguageMode);
          switch (String(gRenderOptions.secondaryLanguageMode)) {
            case 'disabled':
              console.log('Subs disabled.');
              break;
            default:
            case 'audio':
              try {
                // There is also manifest.recommendedMedia.audioTrackId, but it just points to the track with isNative == true
                const defaultAudioTrack = manifest.audio_tracks.find(t => t.isNative == true);
                const defaultAudioLanguage = (defaultAudioTrack) ? defaultAudioTrack.language : manifest.audio_tracks[0].language; // fall back to first track if isNative fails
                console.log(`Default audio track language: ${defaultAudioLanguage}`);
                const autoSubtitleId = gSubtitles.findIndex(t => t.bcp47 == defaultAudioLanguage);
                if (autoSubtitleId >= 0) {
                  console.log(`Subtitle #${autoSubtitleId} auto-enabled to match audio`);
                  activateSubtitle(autoSubtitleId);
                } else {
                  console.log(defaultAudioLanguage + ' subs not available.');
                }
              }
              catch (err) {
                console.error('Default audio track not found, ', err);
              }
              break;
            case 'last':
              if (gRenderOptions.secondaryLanguageLastUsed) {
                console.log('Activating last sub language', gRenderOptions.secondaryLanguageLastUsed)
                try {
                  let lastSubtitleId = gSubtitles.findIndex(t => (t.bcp47 == gRenderOptions.secondaryLanguageLastUsed && t.isCaption == gRenderOptions.secondaryLanguageLastUsedIsCaption));
                  // if can't match CC type, fall back to language only
                  if (lastSubtitleId == -1)
                    lastSubtitleId = gSubtitles.findIndex(t => t.bcp47 == gRenderOptions.secondaryLanguageLastUsed);
                  if (lastSubtitleId >= 0) {
                    console.log(`Subtitle #${lastSubtitleId} enabled`);
                    activateSubtitle(lastSubtitleId);
                  } else {
                    console.log(gRenderOptions.secondaryLanguageLastUsed + ' subs not available.');
                  }
                } catch (err) {
                  console.error('Error activating last sub language, ', err);
                }
              } else {
                console.log('Last used language is empty, subs disabled.');
              }
              break;
          }

          // retrieve video ratio
          try {
            let { maxWidth, maxHeight } = manifest.video_tracks[0];
            gVideoRatio = maxHeight / maxWidth;
          }
          catch (err) {
            console.error('Video ratio not available, ', err);
          }
        }
        catch (err) {
          console.error('Fatal: ', err);
        }

        if (gRendererLoop) {
          gRendererLoop.stop();
          gRendererLoop = null;
          console.log('Terminated: old renderer loop');
        }

        if (!gRendererLoop) {
          gRendererLoop = new RendererLoop(video);
          gRendererLoop.start();
          console.log('Started: renderer loop');
        }

        // detect for newer version of Netflix web player UI
        const hasNeoStyleControls = !!document.querySelector('[class*=PlayerControlsNeo]');
        console.log(`hasNeoStyleControls: ${hasNeoStyleControls}`);
      })
      .catch(err => {
        console.error('Fatal: ', err);
      });
  }

  updateManifest(manifest) {
    try {
      console.log(`Intecerpted manifest: ${manifest.movieId}`);
    }
    catch (err) {
      console.warn('Error:', err);
    }

    this.manifestManager.saveManifest(manifest);
    this.activateManifest(manifest.movieId);
  }

  rendererLoopDestroy() {
    const movieIdInUrl = extractMovieIdFromUrl();
    if (!movieIdInUrl) return;

    console.log(`rendererLoop destroyed, trying to activate: ${movieIdInUrl}`);
    this.lastMovieId = undefined;
    this.activateManifest(movieIdInUrl);
  }
}

// =============================================================================

const nflxMultiSubsManager = new NflxMultiSubsManager();
window.__NflxMultiSubs = nflxMultiSubsManager;  // interface between us and the the manifest hook

// control video playback rate
const playbackRateController = new PlaybackRateController();
playbackRateController.activate();

window.addEventListener('keydown', (event) => {
  // toggle subtitles visibility with 'v'
  if (event.key.toLowerCase() === 'v') {
    const primary = document.querySelector('.nflxmultisubs-primary-wrapper');
    const secondary = document.querySelector('.nflxmultisubs-subtitle-wrapper');

    if (!primary || !secondary)
      return;

    const visible = (window.getComputedStyle(primary).visibility === 'visible') ||
      (window.getComputedStyle(secondary).visibility === 'visible');

    primary.style.visibility = secondary.style.visibility = (visible) ? 'hidden' : 'visible';
  }
}, true);
