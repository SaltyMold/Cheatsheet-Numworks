// Simple client-side image editor + RLE binary export
(function(){
  const fileEl = document.getElementById('file');
  const orig = document.getElementById('orig');
  const prev = document.getElementById('preview');
  const rotateBtn = document.getElementById('rotateBtn');
  const rotateCustomBtn = document.getElementById('rotateCustomBtn');
  const flipHBtn = document.getElementById('flipHBtn');
  const flipVBtn = document.getElementById('flipVBtn');
  const cropBtn = document.getElementById('cropBtn');
  const cropModal = document.getElementById('cropModal');
  const cropCanvas = document.getElementById('cropCanvas');
  const cropConfirm = document.getElementById('cropConfirm');
  const cropCancel = document.getElementById('cropCancel');
  const rotateModal = document.getElementById('rotateModal');
  const rotateCanvas = document.getElementById('rotateCanvas');
  const rotateAngleInput = document.getElementById('rotateAngle');
  const rotateAngleVal = document.getElementById('rotateAngleVal');
  const rotateConfirm = document.getElementById('rotateConfirm');
  const rotateCancel = document.getElementById('rotateCancel');
  const colorsRange = document.getElementById('colors');
  const colorsVal = document.getElementById('colorsVal');
  const invertChk = document.getElementById('invert');
  const sizeRange = document.getElementById('sizeRange');
  const sizeVal = document.getElementById('sizeVal');
  const downloadBtn = document.getElementById('downloadBtn');
  const downloadPreviewBtn = document.getElementById('downloadPreviewBtn');
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  const binSizeEl = document.getElementById('binSize');

  const octx = orig.getContext('2d');
  const pctx = prev.getContext('2d');
  const lens = document.getElementById('lens');
  const lctx = lens ? lens.getContext('2d') : null;
  const previewWrap = document.querySelector('.preview-wrap');
  const origWrap = document.querySelector('.orig-wrap');
  const LENS_SIZE = lens ? lens.width : 200;
  const LENS_ZOOM = 2.5;
  const openBtn = document.getElementById('openBtn');

  if(sizeRange && sizeVal) sizeVal.textContent = sizeRange.value;
  let previewDisplayScale = 1; // display scale of preview (internal px -> CSS px)
  let previewSizeEl = document.getElementById('previewSize');

  // preview size badge element (displayed next to "Preview (quantized)")
  if (!previewSizeEl) {
      previewSizeEl = document.createElement('span');
      previewSizeEl.id = 'previewSize';
      previewWrap.appendChild(previewSizeEl);
  }

  function clientToCanvasPreview(clientX, clientY){
    const r = prev.getBoundingClientRect();
    const scaleX = prev.width / r.width;
    const scaleY = prev.height / r.height;
    return { x: (clientX - r.left) * scaleX, y: (clientY - r.top) * scaleY, relX: clientX - r.left, relY: clientY - r.top };
  }

  let img = new Image();
  let state = {w:orig.width,h:orig.height,angle:0};
  const history = [];
  let redoStack = [];
  let initialIntrinsic = null; // store initial file dimensions (never overwritten)
  let originalIntrinsic = null; // store current image intrinsic (updated on edits)
  let originalFileSize = null;

  // hide preview on startup (show when image is loaded)
  if(prev) prev.classList.add('hidden');

  // --- Session persistence (localStorage) ---
  const SESSION_KEY = 'highImage:lastSession';

  function saveSession(){
    try{
      if(!orig) return;
      // Prepare lightweight copies of history and redo stacks to avoid blowing localStorage
      function serializeStack(stack){
        try{
          if(!Array.isArray(stack) || stack.length===0) return [];
          const max = 6; // keep only last 6 states
          const out = [];
          for(let i=Math.max(0, stack.length-max); i<stack.length; i++){
            const it = stack[i];
            if(!it || !it.src) continue;
            // only include reasonably-sized data URLs (skip huge ones)
            // allow larger threshold because we store as JPEG where possible
            if(it.src.length > 900000) continue;
            out.push({ src: it.src, w: it.w, h: it.h, originalIntrinsic: it.originalIntrinsic });
          }
          return out;
        }catch(e){ return []; }
      }

      const data = {
        // use JPEG for session image to reduce size and increase chance of saving
        image: (function(){ try{ return orig.toDataURL('image/jpeg', 0.8); }catch(e){ return orig.toDataURL(); } })(),
        state: { w: state.w, h: state.h },
        originalIntrinsic: originalIntrinsic,
        colors: colorsRange ? colorsRange.value : null,
          size: sizeRange ? sizeRange.value : null,
        invert: invertChk ? invertChk.checked : false,
        history: serializeStack(history),
        redoStack: serializeStack(redoStack),
        timestamp: Date.now()
      };
      try{
        localStorage.setItem(SESSION_KEY, JSON.stringify(data));
      }catch(e){
        // If storage quota exceeded, attempt a smaller save without stacks
        const small = { image: data.image, state: data.state, originalIntrinsic: data.originalIntrinsic, colors: data.colors, invert: data.invert, timestamp: data.timestamp };
        try{ localStorage.setItem(SESSION_KEY, JSON.stringify(small)); }catch(e2){ /* give up */ }
      }
    }catch(e){ /* ignore */ }
  }

  function loadSession(){
    try{
      const raw = localStorage.getItem(SESSION_KEY);
      if(!raw) return false;
      const data = JSON.parse(raw);
      if(!data || !data.image) return false;
      img = new Image();
      img.onload = ()=>{
        // restore state from saved canvas image
        state.w = data.state && data.state.w ? data.state.w : img.width;
        state.h = data.state && data.state.h ? data.state.h : img.height;
        originalIntrinsic = data.originalIntrinsic || { w: state.w, h: state.h };
        sel = null;
        history.length = 0;
        // restore history/redo stacks if present
        try{
          if(Array.isArray(data.history)){
            history.push(...data.history);
          }
          if(Array.isArray(data.redoStack)){
            redoStack.push(...data.redoStack);
          }
        }catch(e){}
        drawImageToOrig();
        if(colorsRange && data.colors) colorsRange.value = data.colors;
        if(colorsVal) colorsVal.textContent = colorsRange.value;
        if(sizeRange && data.size) sizeRange.value = data.size;
        if(sizeVal) sizeVal.textContent = sizeRange ? sizeRange.value : '4';
        if(invertChk) invertChk.checked = !!data.invert;
        updatePreview();
        if(prev) prev.classList.remove('hidden');
      };
      img.src = data.image;
      return true;
    }catch(e){ return false; }
  }

  function clearSession(){ localStorage.removeItem(SESSION_KEY); }

  function pushHistory(){
    try{
      if(!img.src) return;
      // use JPEG output for history to reduce data URL size for localStorage
      var dataUrl;
      try{ dataUrl = orig.toDataURL('image/jpeg', 0.8); }catch(e){ dataUrl = orig.toDataURL(); }
      history.push({src: dataUrl, w: state.w, h: state.h, originalIntrinsic: originalIntrinsic});
      // push a new state clears the redo stack
      redoStack.length = 0;
      if(history.length>12) history.shift();
    }catch(e){/* ignore */}
  }

  // selection for crop
  let sel = null;
  let dragging=false, sx=0, sy=0;
  // modal selection state
  let modalSel = null;
  let modalDragging = false;
  let modalScale = 1;

  function clientToCanvas(clientX, clientY){
    const r = orig.getBoundingClientRect();
    const scaleX = orig.width / r.width;
    const scaleY = orig.height / r.height;
    return { x: (clientX - r.left) * scaleX, y: (clientY - r.top) * scaleY };
  }

  function drawImageToOrig(){
    orig.width = state.w;
    orig.height = state.h;
    octx.setTransform(1,0,0,1,0,0);
    octx.clearRect(0,0,orig.width,orig.height);
    octx.drawImage(img,0,0,state.w,state.h);
    drawSelection();
    // update displayed original size badge (show intrinsic image size when available)
    try{
      const origSizeEl = document.getElementById('origSize');
      if(origSizeEl){
        // display current image size (after any edits like crop/rotate)
        origSizeEl.textContent = state.w + '×' + state.h;
      }
    }catch(e){}
    // adjust displayed size to fit its container without stretching
    updateOrigDisplay();
  }

  function updateOrigDisplay(){
    try{
      if(!origWrap || !orig) return;
      const wrapRect = origWrap.getBoundingClientRect();
      const maxW = Math.max(40, wrapRect.width - 12);
      const maxH = Math.max(40, wrapRect.height - 12);
      const scale = Math.min(1, Math.min(maxW / state.w, maxH / state.h));
      orig.style.width = Math.round(state.w * scale) + 'px';
      orig.style.height = Math.round(state.h * scale) + 'px';
    }catch(e){}
  }

  function drawSelection(){
    if(!sel) return;
    octx.save();
    // darken area outside selection using even-odd fill rule
    octx.beginPath();
    octx.rect(0,0,orig.width,orig.height);
    octx.rect(sel.x, sel.y, sel.w, sel.h);
    octx.fillStyle = 'rgba(0,0,0,0.36)';
    try{ octx.fill('evenodd'); }catch(e){ octx.fill(); }
    // selection border
    octx.strokeStyle = '#72f1ff';
    octx.lineWidth = Math.max(1, Math.round(Math.min(orig.width, orig.height) / 300));
    octx.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.w - 1, sel.h - 1);
    octx.restore();
  }

  fileEl.addEventListener('change',e=>{
    const f = e.target.files && e.target.files[0];
    if(!f) return;
    originalFileSize = f.size;
    const url = URL.createObjectURL(f);
    img = new Image();
    img.onload = ()=>{
      // capture intrinsic size from original file load
      originalIntrinsic = { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
      if(!initialIntrinsic) initialIntrinsic = { w: originalIntrinsic.w, h: originalIntrinsic.h };
      // use actual image dimensions without constraining
      state.w = originalIntrinsic.w;
      state.h = originalIntrinsic.h;
      state.angle = 0;
      sel = null;
      history.length = 0;
      pushHistory();
      drawImageToOrig();
      updatePreview();
      // show preview (was hidden on startup)
      if(prev) prev.classList.remove('hidden');
      // clear redo stack on new load
      redoStack.length = 0;
      // save session after loading new file
      saveSession();
    };
    img.src = url;
  });

  // toolbar interactions
  if(openBtn){ openBtn.addEventListener('click', ()=> fileEl.click()); }

  // keyboard shortcuts (limited)
  window.addEventListener('keydown', e=>{
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'){ e.preventDefault(); undoBtn.click(); }
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's'){ e.preventDefault(); downloadBtn.click(); }
    if(e.key === 'Delete' || e.key === 'Backspace'){ sel = null; drawImageToOrig(); }
  });
  window.addEventListener('mouseup', e=>{
    if(!dragging) return;
    dragging=false;
    if(!sel) return;
    if(sel.w<0){ sel.x += sel.w; sel.w = -sel.w; }
    if(sel.h<0){ sel.y += sel.h; sel.h = -sel.h; }
    // clamp to canvas bounds
    sel.x = Math.max(0, Math.min(sel.x, orig.width));
    sel.y = Math.max(0, Math.min(sel.y, orig.height));
    sel.w = Math.max(0, Math.min(sel.w, orig.width - sel.x));
    sel.h = Math.max(0, Math.min(sel.h, orig.height - sel.y));
    // cancel too-small selections
    if(sel.w < 4 || sel.h < 4) sel = null;
    drawImageToOrig();
  });

  // open crop modal
  cropBtn.addEventListener('click', ()=>{
    if(!img.src) return alert('Chargez une image avant de rogner');
    // prepare modal canvas scaled to fit viewport
    const maxW = Math.round(window.innerWidth * 0.8);
    const maxH = Math.round(window.innerHeight * 0.7);
    const sw = state.w, sh = state.h;
    modalScale = Math.min(1, Math.min(maxW / sw, maxH / sh));
    const cw = Math.max(200, Math.round(sw * modalScale));
    const ch = Math.max(120, Math.round(sh * modalScale));
    cropCanvas.width = cw; cropCanvas.height = ch;
    const cctx = cropCanvas.getContext('2d');
    cctx.clearRect(0,0,cw,ch);
    // draw current original image into modal canvas scaled
    cctx.drawImage(orig, 0, 0, state.w, state.h, 0, 0, cw, ch);
    // reset modal selection
    modalSel = null; modalDragging = false;
    // show modal
    cropModal.setAttribute('aria-hidden','false');
  });

  // modal mouse handling for selection
  if(cropCanvas){
    const mc = cropCanvas;
    const mctx = mc.getContext('2d');
    function redrawModal(){
      // redraw image
      mctx.clearRect(0,0,mc.width,mc.height);
      mctx.drawImage(orig, 0, 0, state.w, state.h, 0, 0, mc.width, mc.height);
      if(modalSel){
        mctx.save();
        mctx.beginPath();
        mctx.rect(0,0,mc.width,mc.height);
        mctx.rect(modalSel.x, modalSel.y, modalSel.w, modalSel.h);
        mctx.fillStyle = 'rgba(0,0,0,0.36)';
        try{ mctx.fill('evenodd'); }catch(e){ mctx.fill(); }
        mctx.strokeStyle = '#72f1ff'; mctx.lineWidth = 2;
        mctx.strokeRect(modalSel.x+0.5, modalSel.y+0.5, modalSel.w-1, modalSel.h-1);
        mctx.restore();
      }
    }
    mc.addEventListener('mousedown', e=>{
      const r = mc.getBoundingClientRect();
      const x = (e.clientX - r.left);
      const y = (e.clientY - r.top);
      modalSel = { x: x, y: y, w: 0, h: 0 };
      modalDragging = true;
    });
    // Touch support for mobile: start selection
    mc.addEventListener('touchstart', e=>{
      if(!e.touches || e.touches.length===0) return;
      const t = e.touches[0];
      const r = mc.getBoundingClientRect();
      const x = (t.clientX - r.left);
      const y = (t.clientY - r.top);
      modalSel = { x: x, y: y, w: 0, h: 0 };
      modalDragging = true;
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('mousemove', e=>{
      if(!modalDragging) return;
      const r = mc.getBoundingClientRect();
      const x = (e.clientX - r.left);
      const y = (e.clientY - r.top);
      modalSel.w = x - modalSel.x; modalSel.h = y - modalSel.y;
      redrawModal();
    });
    // Touch move support while dragging selection
    window.addEventListener('touchmove', e=>{
      if(!modalDragging) return;
      if(!e.touches || e.touches.length===0) return;
      const t = e.touches[0];
      const r = mc.getBoundingClientRect();
      const x = (t.clientX - r.left);
      const y = (t.clientY - r.top);
      modalSel.w = x - modalSel.x; modalSel.h = y - modalSel.y;
      redrawModal();
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('mouseup', e=>{
      if(!modalDragging) return; modalDragging = false;
      if(!modalSel) return;
      if(modalSel.w<0){ modalSel.x += modalSel.w; modalSel.w = -modalSel.w; }
      if(modalSel.h<0){ modalSel.y += modalSel.h; modalSel.h = -modalSel.h; }
      // clamp
      modalSel.x = Math.max(0, Math.min(modalSel.x, mc.width));
      modalSel.y = Math.max(0, Math.min(modalSel.y, mc.height));
      modalSel.w = Math.max(0, Math.min(modalSel.w, mc.width - modalSel.x));
      modalSel.h = Math.max(0, Math.min(modalSel.h, mc.height - modalSel.y));
      if(modalSel.w < 4 || modalSel.h < 4) modalSel = null;
      redrawModal();
    });
    // Touch end support to finish selection
    window.addEventListener('touchend', e=>{
      if(!modalDragging) return; modalDragging = false;
      if(!modalSel) return;
      if(modalSel.w<0){ modalSel.x += modalSel.w; modalSel.w = -modalSel.w; }
      if(modalSel.h<0){ modalSel.y += modalSel.h; modalSel.h = -modalSel.h; }
      // clamp
      modalSel.x = Math.max(0, Math.min(modalSel.x, mc.width));
      modalSel.y = Math.max(0, Math.min(modalSel.y, mc.height));
      modalSel.w = Math.max(0, Math.min(modalSel.w, mc.width - modalSel.x));
      modalSel.h = Math.max(0, Math.min(modalSel.h, mc.height - modalSel.y));
      if(modalSel.w < 4 || modalSel.h < 4) modalSel = null;
      redrawModal();
      e.preventDefault();
    }, { passive: false });
  }

  // modal controls
  if(cropCancel){ cropCancel.addEventListener('click', ()=>{ cropModal.setAttribute('aria-hidden','true'); modalSel=null; }); }
  if(cropConfirm){
    cropConfirm.addEventListener('click', ()=>{
      if(!modalSel){ alert('Sélectionnez une zone à rogner'); return; }
      // map modal selection back to original image coords
      const ox = Math.max(0, Math.floor(modalSel.x / modalScale));
      const oy = Math.max(0, Math.floor(modalSel.y / modalScale));
      const ow = Math.max(1, Math.floor(modalSel.w / modalScale));
      const oh = Math.max(1, Math.floor(modalSel.h / modalScale));
      pushHistory();
      const tmp = document.createElement('canvas'); tmp.width = ow; tmp.height = oh;
      tmp.getContext('2d').drawImage(orig, ox, oy, ow, oh, 0,0, ow, oh);
      img = new Image(); img.onload = ()=>{ state.w = tmp.width; state.h = tmp.height; sel=null; originalIntrinsic = {w: tmp.width, h: tmp.height}; drawImageToOrig(); updatePreview(); cropModal.setAttribute('aria-hidden','true'); };
      img.src = tmp.toDataURL();
      // save session after crop
      setTimeout(saveSession, 50);
    });
  }

  rotateBtn.addEventListener('click', ()=>{
    // rotate 90° clockwise
    pushHistory();
    const tmp = document.createElement('canvas');
    tmp.width = state.h; tmp.height = state.w;
    const tctx = tmp.getContext('2d');
    tctx.translate(tmp.width/2,tmp.height/2);
    tctx.rotate(Math.PI/2);
    tctx.drawImage(orig, -state.w/2, -state.h/2);
    img = new Image(); img.onload = ()=>{ state.w = tmp.width; state.h = tmp.height; sel=null; originalIntrinsic = {w: tmp.width, h: tmp.height}; drawImageToOrig(); updatePreview(); }; img.src = tmp.toDataURL();
    // save session after rotate
    setTimeout(saveSession, 50);
  });

  // flip horizontal
  if(flipHBtn){
    flipHBtn.addEventListener('click', ()=>{
      if(!img.src) return alert('Chargez une image avant de retourner');
      pushHistory();
      const tmp = document.createElement('canvas');
      tmp.width = state.w; tmp.height = state.h;
      const tctx = tmp.getContext('2d');
      tctx.translate(tmp.width, 0);
      tctx.scale(-1, 1);
      tctx.drawImage(orig, 0, 0);
      img = new Image(); img.onload = ()=>{ sel=null; originalIntrinsic = {w: tmp.width, h: tmp.height}; drawImageToOrig(); updatePreview(); }; img.src = tmp.toDataURL();
      setTimeout(saveSession, 50);
    });
  }

  // flip vertical
  if(flipVBtn){
    flipVBtn.addEventListener('click', ()=>{
      if(!img.src) return alert('Chargez une image avant de retourner');
      pushHistory();
      const tmp = document.createElement('canvas');
      tmp.width = state.w; tmp.height = state.h;
      const tctx = tmp.getContext('2d');
      tctx.translate(0, tmp.height);
      tctx.scale(1, -1);
      tctx.drawImage(orig, 0, 0);
      img = new Image(); img.onload = ()=>{ sel=null; originalIntrinsic = {w: tmp.width, h: tmp.height}; drawImageToOrig(); updatePreview(); }; img.src = tmp.toDataURL();
      setTimeout(saveSession, 50);
    });
  }

  // open rotate modal
  if(rotateCustomBtn){
    rotateCustomBtn.addEventListener('click', ()=>{
      if(!img.src) return alert('Chargez une image avant de tourner');
      // prepare modal canvas
      const maxW = Math.round(window.innerWidth * 0.8);
      const maxH = Math.round(window.innerHeight * 0.7);
      const sw = state.w, sh = state.h;
      const scale = Math.min(1, Math.min(maxW / sw, maxH / sh));
      const cw = Math.max(200, Math.round(sw * scale));
      const ch = Math.max(120, Math.round(sh * scale));
      rotateCanvas.width = cw; rotateCanvas.height = ch;
      // reset angle
      rotateAngleInput.value = 0;
      rotateAngleVal.textContent = '0';
      // show modal
      rotateModal.setAttribute('aria-hidden','false');
      // preview initial
      redrawRotatePreview(0, scale);
    });
  }

  // rotate preview function
  let rotatePreviewScale = 1;
  // compute largest axis-aligned rectangle that fits inside a rotated w×h rectangle
  function largestRotatedRect(w, h, angleRad) {
    // Normalize angle to first quadrant for correct geometry
    let angle = Math.abs(angleRad);
    if (angle > Math.PI / 2) angle = Math.PI - angle;

    const sin = Math.abs(Math.sin(angle));
    const cos = Math.abs(Math.cos(angle));

    const widthIsLonger = w >= h;
    const sideLong = widthIsLonger ? w : h;
    const sideShort = widthIsLonger ? h : w;

    let wr, hr;

    if (sideShort <= 2 * sin * cos * sideLong) {
      const x = 0.5 * sideShort;
      if (widthIsLonger) {
        wr = x / sin;
        hr = x / cos;
      } else {
        wr = x / cos;
        hr = x / sin;
      }
    } else {
      const cos2MinusSin2 = (cos * cos) - (sin * sin);
      wr = (w * cos - h * sin) / cos2MinusSin2;
      hr = (h * cos - w * sin) / cos2MinusSin2;
    }

    return {
      width: Math.floor(Math.abs(wr)),
      height: Math.floor(Math.abs(hr))
    };
  }
  function redrawRotatePreview(angleDeg, scale){
    if(!rotateCanvas) return;
    const rctx = rotateCanvas.getContext('2d');
    rctx.clearRect(0,0,rotateCanvas.width, rotateCanvas.height);
    rctx.save();
    rctx.translate(rotateCanvas.width/2, rotateCanvas.height/2);
    rctx.rotate(angleDeg * Math.PI / 180);
    rctx.drawImage(orig, 0, 0, state.w, state.h, -state.w * scale / 2, -state.h * scale / 2, state.w * scale, state.h * scale);
    rctx.restore();
    // draw crop overlay as a screen-aligned rectangle (not rotated with the image)
    try{
      const rad = angleDeg * Math.PI / 180;
      const rect = largestRotatedRect(state.w, state.h, rad);
      const cropW = rect.width * scale;
      const cropH = rect.height * scale;
      const cx = rotateCanvas.width / 2;
      const cy = rotateCanvas.height / 2;
      rctx.beginPath();
      rctx.rect(0, 0, rotateCanvas.width, rotateCanvas.height);
      rctx.rect(cx - cropW/2, cy - cropH/2, cropW, cropH);
      rctx.fillStyle = 'rgba(0,0,0,0.36)';
      try{ rctx.fill('evenodd'); }catch(e){ rctx.fill(); }
      rctx.strokeStyle = '#72f1ff';
      rctx.lineWidth = 2;
      rctx.strokeRect(Math.round(cx - cropW/2 + 0.5), Math.round(cy - cropH/2 + 0.5), Math.max(0, Math.round(cropW - 1)), Math.max(0, Math.round(cropH - 1)));
    }catch(e){/* ignore overlay errors */}
  }

  // rotate modal controls
  if(rotateAngleInput){
    rotateAngleInput.addEventListener('input', ()=>{
      const angle = parseInt(rotateAngleInput.value, 10);
      rotateAngleVal.textContent = angle;
      const maxW = Math.round(window.innerWidth * 0.8);
      const maxH = Math.round(window.innerHeight * 0.7);
      const sw = state.w, sh = state.h;
      const scale = Math.min(1, Math.min(maxW / sw, maxH / sh));
      redrawRotatePreview(angle, scale);
    });
  }

  if(rotateCancel){ rotateCancel.addEventListener('click', ()=>{ rotateModal.setAttribute('aria-hidden','true'); }); }
if (rotateConfirm) {
  rotateConfirm.addEventListener('click', () => {
    const angle = parseInt(rotateAngleInput.value, 10);
    if (angle === 0) {
      rotateModal.setAttribute('aria-hidden','true');
      return;
    }

    pushHistory();

    const rad = angle * Math.PI / 180;
    const w = state.w;
    const h = state.h;

    const tmp = document.createElement('canvas');

    const absW = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
    const absH = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));

    tmp.width = Math.ceil(absW);
    tmp.height = Math.ceil(absH);

    const tctx = tmp.getContext('2d');
    tctx.translate(tmp.width / 2, tmp.height / 2);
    tctx.rotate(rad);
    tctx.drawImage(orig, -w / 2, -h / 2);

    const rect = largestRotatedRect(w, h, rad);

    const cropW = rect.width;
    const cropH = rect.height;

    const offsetX = Math.floor((tmp.width - cropW) / 2);
    const offsetY = Math.floor((tmp.height - cropH) / 2);

    const cropped = document.createElement('canvas');
    cropped.width = cropW;
    cropped.height = cropH;

    cropped.getContext('2d').drawImage(
      tmp,
      offsetX, offsetY, cropW, cropH,
      0, 0, cropW, cropH
    );

    img = new Image();
    img.onload = () => {
      state.w = cropped.width;
      state.h = cropped.height;
      sel = null;
      originalIntrinsic = { w: cropped.width, h: cropped.height };
      drawImageToOrig();
      updatePreview();
      rotateModal.setAttribute('aria-hidden','true');
      // save session after custom rotate+crop applied
      setTimeout(saveSession, 50);
    };

    img.src = cropped.toDataURL();
  });
}

  // reset button removed from UI; no-op kept for compatibility.

  colorsRange.addEventListener('input', ()=>{ colorsVal.textContent = colorsRange.value; updatePreview(); });
  invertChk.addEventListener('change', updatePreview);
  // save palette/invert changes to session
  if(colorsRange) colorsRange.addEventListener('change', saveSession);
  if(invertChk) invertChk.addEventListener('change', saveSession);
  if(sizeRange){
    sizeRange.addEventListener('input', ()=>{ if(sizeVal) sizeVal.textContent = sizeRange.value; updatePreview(); });
    sizeRange.addEventListener('change', saveSession);
  }

  // Note: preview and output are now based on tiles of 320×240 (see updatePreview)

  function updatePreview(){
    if(!img.src) return;
    // render a preview for export (internal size) according to sizeRange (tiles of 320x240)
    const mult = sizeRange ? Math.max(1, Math.min(12, parseInt(sizeRange.value,10)||4)) : 4;
    const W = 320 * mult, H = 240 * mult;
    // set internal canvas resolution
    prev.width = W; prev.height = H;
    pctx.clearRect(0,0,prev.width,prev.height);
    // draw the original canvas into the preview scaled to W x H
    pctx.drawImage(orig, 0, 0, state.w, state.h, 0, 0, W, H);
    // quantize pixel data
    const data = pctx.getImageData(0,0,prev.width,prev.height);
    const ncolors = parseInt(colorsRange.value,10);
    for(let i=0;i<data.data.length;i+=4){
      const r=data.data[i], g=data.data[i+1], b=data.data[i+2];
      let intensity = Math.round((r+g+b)/3);
      let idx = Math.round(intensity/255*(ncolors-1));
      if(invertChk.checked) idx = (ncolors-1)-idx;
      const gray = Math.round(idx/(ncolors-1)*255);
      data.data[i]=data.data[i+1]=data.data[i+2]=gray;
    }
    pctx.putImageData(data,0,0);

    // compute display scale to fit previewWrap without overflowing
    try{
      const wrapRect = previewWrap.getBoundingClientRect();
      const maxW = Math.max(40, wrapRect.width - 12); // padding guard
      const maxH = Math.max(40, wrapRect.height - 12);
      const scale = Math.min(1, Math.min(maxW / W, maxH / H));
      prev.style.width = Math.round(W * scale) + 'px';
      prev.style.height = Math.round(H * scale) + 'px';
      previewDisplayScale = scale;
      // ensure preview size badge exists
      if(!previewSizeEl){
        previewSizeEl = document.getElementById('previewSize');
        if(!previewSizeEl){
          previewSizeEl = document.createElement('span');
          previewSizeEl.id = 'previewSize';
          // try to copy styling from origSize if present so it looks the same
          const origSizeEl = document.getElementById('origSize');
          if(origSizeEl) {
            previewSizeEl.className = origSizeEl.className || '';
          } else {
            previewSizeEl.style.position = 'absolute';
            previewSizeEl.style.top = '6px';
            previewSizeEl.style.right = '6px';
            previewSizeEl.style.background = 'rgba(255,255,255,0.9)';
            previewSizeEl.style.border = '1px solid rgba(0,0,0,0.08)';
            previewSizeEl.style.padding = '2px 6px';
            previewSizeEl.style.borderRadius = '4px';
            previewSizeEl.style.fontSize = '0.9em';
            previewSizeEl.style.color = '#333';
            previewSizeEl.style.zIndex = '50';
          }
          // ensure previewWrap can position absolutely-placed badge
          if(previewWrap){
            const cs = window.getComputedStyle(previewWrap);
            if(cs.position === 'static') previewWrap.style.position = 'relative';
            previewWrap.appendChild(previewSizeEl);
          } else {
            document.body.appendChild(previewSizeEl);
          }
        }
      }
      if(previewSizeEl) previewSizeEl.textContent = W + '×' + H;
      // ensure lens stays on top if visible
      if(lens) lens.style.display = '';
    }catch(e){
      // fallback: allow css to constrain
      prev.style.width = '';
      prev.style.height = '';
    }

    // update binary size info
    const size = computeBinarySize();
    if(binSizeEl) binSizeEl.textContent = humanFileSize(size);
    // update preview size badge (internal canvas size)
    try { if(previewSizeEl) previewSizeEl.textContent = prev.width + '×' + prev.height; } catch(e) {}
  }

  // recalc preview display on window resize
  window.addEventListener('resize', ()=>{ updatePreview(); updateOrigDisplay(); });

  function humanFileSize(bytes){
    if(!bytes) return '0 o';
    const thresh = 1024;
    if(Math.abs(bytes) < thresh) return bytes + ' o';
    const units = ['ko','Mo','Go','To','Po','Eo','Zo','Yo'];
    let u = -1; do { bytes /= thresh; ++u; } while(Math.abs(bytes) >= thresh && u < units.length-1);
    return bytes.toFixed(1)+' '+units[u];
  }

  function computeBinarySize(){
    if(!img.src) return 0;
    const ncolors = parseInt(colorsRange.value,10);
    const invert = invertChk.checked;
    const w = prev.width, h = prev.height;
    const imgd = pctx.getImageData(0,0,w,h).data;
    let size = 0;
    for(let y=0;y<h;y++){
      for(let xChunk=0;xChunk<w;xChunk+=320){
        const xEnd = Math.min(xChunk+320,w);
        let cur = Math.round(imgd[(y*w + xChunk)*4]/255*(ncolors-1));
        if(invert) cur = (ncolors-1)-cur;
        cur = Math.round(cur/(ncolors-1)*15);
        let run = 1;
        for(let x = xChunk+1; x<xEnd; x++){
          let v = Math.round(imgd[(y*w + x)*4]/255*(ncolors-1));
          if(invert) v = (ncolors-1)-v;
          v = Math.round(v/(ncolors-1)*15);
          if(v === cur && run < 16){ run++; }
          else{ size++; cur = v; run = 1; }
        }
        if(run>0) size++;
      }
    }
    return size;
  }

  // download binary with RLE per Python spec
  downloadBtn.addEventListener('click', ()=>{
    if(!img.src) return alert('Chargez et appliquez la palette (bouton Apply)');
    // build palette quantization parameters
    const ncolors = parseInt(colorsRange.value,10);
    const invert = invertChk.checked;
    // get pixel data from preview (which is quantized if user applied palette; ensure quantize now)
    updatePreview();
    const w = prev.width, h = prev.height;
    const imgd = pctx.getImageData(0,0,w,h).data;
    const indices = [];
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        const i = (y*w + x)*4;
        const intensity = imgd[i]; // already gray
        let idx = Math.round(intensity/255*(ncolors-1));
        if(invert) idx = (ncolors-1)-idx;
        // map to 0..15 scale (since palette indices expected 0..15)
        const mapped = Math.round(idx/(ncolors-1)*15);
        indices.push(mapped & 0x0F);
      }
    }

    // RLE encode per row, chunked by 320 pixels
    const out = [];
    for(let y=0;y<h;y++){
      for(let xChunk=0;xChunk<w;xChunk+=320){
        const xEnd = Math.min(xChunk+320,w);
        // process this chunk
        let cur = indices[y*w + xChunk];
        let run = 1;
        for(let x = xChunk+1; x<xEnd; x++){
          const v = indices[y*w + x];
          if(v === cur && run < 16){ run++; }
          else{
            out.push(((run-1)&0x0F)<<4 | (cur&0x0F));
            cur = v; run = 1;
          }
        }
        if(run>0){ out.push(((run-1)&0x0F)<<4 | (cur&0x0F)); }
      }
    }

    const u8 = new Uint8Array(out);
    const blob = new Blob([u8],{type:'application/octet-stream'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'input.bin'; a.click();
    URL.revokeObjectURL(url);
  });

  downloadPreviewBtn.addEventListener('click', ()=>{
    if(!img.src) return alert('Chargez une image');
    prev.toBlob(blob=>{
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'preview.png'; a.click();
      URL.revokeObjectURL(url);
    });
  });

  // magnifier / loupe on preview
  if(lens && previewWrap && lctx){
    previewWrap.addEventListener('mousemove', e => {
      if(!img.src) return;
      const p = clientToCanvasPreview(e.clientX, e.clientY);
      // adapt effective zoom based on preview display scale so loupe is usable
      // use a proportional (not inverse) scaling: when the preview is smaller
      // the loupe zoom is reduced rather than amplified.
      const displayScale = Math.max(0.1, (previewDisplayScale || 1));
      const effectiveZoom = Math.max(1, Math.min(8, 1 + (LENS_ZOOM - 1) * displayScale));
      const srcW = LENS_SIZE / effectiveZoom;
      const srcH = srcW;
      let sx = p.x - srcW/2;
      let sy = p.y - srcH/2;
      sx = Math.max(0, Math.min(sx, prev.width - srcW));
      sy = Math.max(0, Math.min(sy, prev.height - srcH));
      lctx.clearRect(0,0,lens.width,lens.height);
      lctx.drawImage(prev, sx, sy, srcW, srcH, 0, 0, lens.width, lens.height);
      const r = previewWrap.getBoundingClientRect();
      lens.style.left = (e.clientX - r.left) + 'px';
      lens.style.top = (e.clientY - r.top) + 'px';
      lens.style.opacity = '1';
      lens.style.transform = 'translate(-50%,-50%) scale(1)';
    });
    previewWrap.addEventListener('mouseleave', ()=>{
      lens.style.opacity = '0';
      lens.style.transform = 'translate(-50%,-50%) scale(0.98)';
    });
    previewWrap.addEventListener('mouseenter', ()=>{ lens.style.opacity = '1'; });
  }

  undoBtn.addEventListener('click', ()=>{
    if(history.length<=0) return;
    // save current state to redo
    try{ if(img.src) redoStack.push({src: orig.toDataURL(), w: state.w, h: state.h, originalIntrinsic: originalIntrinsic}); }catch(e){}
    const last = history.pop();
    if(!last) return;
    img = new Image();
    img.onload = ()=>{
      state.w = last.w;
      state.h = last.h;
      if(last.originalIntrinsic) originalIntrinsic = last.originalIntrinsic;
      sel=null; drawImageToOrig(); updatePreview();
      // save session after undo
      setTimeout(saveSession, 50);
    };
    img.src = last.src;
  });

  if(redoBtn){
    redoBtn.addEventListener('click', ()=>{
      if(redoStack.length<=0) return;
      // save current state to history (so undo remains possible)
      try{ if(img.src) history.push({src: orig.toDataURL(), w: state.w, h: state.h, originalIntrinsic: originalIntrinsic}); }catch(e){}
      const next = redoStack.pop();
      if(!next) return;
      img = new Image();
      img.onload = ()=>{
        state.w = next.w;
        state.h = next.h;
        if(next.originalIntrinsic) originalIntrinsic = next.originalIntrinsic;
        sel = null; drawImageToOrig(); updatePreview();
        // save session after redo
        setTimeout(saveSession, 50);
      };
      img.src = next.src;
    });
  }

  // initially
  // try restore last session; fall back to initial preview
  if(!loadSession()) updatePreview();

  // ensure we persist on unload too
  window.addEventListener('beforeunload', ()=>{ try{ saveSession(); }catch(e){} });

})();
