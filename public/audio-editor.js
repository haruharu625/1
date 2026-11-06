/** Additional audio is independent of the video's original audio and trim. */
export function createAudioEditor(options) {
  const {
    createId, formatTime, getDuration, getTime, isPlaying, isLocked,
    isSelected, onSelect, onChange, onMessage,
  } = options;
  const $ = id => document.getElementById(id);
  const assets = [];
  const tracks = [];
  const players = new Map();
  let selectedId = null;
  let uploading = false;
  let locked = false;
  const selected = () => tracks.find(track => track.id === selectedId);
  const assetFor = track => assets.find(asset => asset.id === track.audioId);
  const round = value => Number(value.toFixed(3));
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function updatePickers() {
    const disabled = locked || isLocked() || uploading || getDuration() <= 0;
    document.querySelectorAll('.audio-file-input').forEach(input => {
      input.disabled = disabled;
      input.closest('.file-picker').setAttribute('aria-disabled', String(disabled));
    });
    $('audio-guide').textContent = getDuration() > 0
      ? 'MP3・WAV・M4A など、1ファイル最大100MB。最大8本の音声を重ねられます。'
      : '動画を追加してから、音声ファイルを選択できます。MP3・WAV・M4A など、1ファイル最大100MB。';
    $('audio-count').textContent = assets.length;
  }

  function select(id) {
    if (locked || isLocked()) return;
    selectedId = id;
    const track = selected();
    if (track) onSelect(track.id, track.offset);
  }

  function renderLibrary() {
    const library = $('audio-library');
    library.replaceChildren();
    for (const asset of assets) {
      const button = make('button', 'audio-asset');
      button.type = 'button';
      button.disabled = locked;
      button.setAttribute('aria-label', `${asset.name} を音声トラックに追加`);
      const info = make('span', 'audio-asset-info');
      info.append(make('strong', '', asset.name), make('small', '', formatTime(asset.duration)));
      button.append(make('span', 'audio-asset-icon', '♫'), info, make('span', '', '+'));
      button.addEventListener('click', () => addTrack(asset));
      library.append(button);
    }
    updatePickers();
  }

  function addTrack(asset) {
    if (locked || isLocked()) return;
    if (getDuration() <= 0) return onMessage('先に動画を追加してください。');
    if (tracks.length >= 8) return onMessage('音声トラックは最大8本まで追加できます。', true);
    const offset = getTime() < getDuration() - 0.1 ? getTime() : 0;
    const track = {
      id: createId(), audioId: asset.id, start: 0,
      end: Math.min(asset.duration, getDuration() - offset), offset, volume: 0.5,
    };
    tracks.push(track);
    const player = new Audio(asset.url);
    player.preload = 'metadata';
    player.className = 'audio-preview-source';
    player.hidden = true;
    document.body.append(player);
    player.addEventListener('loadedmetadata', () => sync(getTime(), isPlaying()));
    player.addEventListener('error', () => {
      if (players.has(track.id) && !track.previewError) {
        track.previewError = true;
        onMessage('この音声はブラウザで再生できません。MP4への書き出しをお試しください。', true);
      }
    });
    players.set(track.id, player);
    onChange();
    select(track.id);
  }

  function renderTimeline() {
    const lane = $('audio-track');
    lane.replaceChildren();
    lane.style.height = tracks.length ? `${tracks.length * 29 + 6}px` : '33px';
    const total = getDuration();
    if (!tracks.length) lane.append(make('span', 'track-hint', '左の「音声」からBGMや別の音声を追加できます'));
    tracks.forEach((track, index) => {
      const button = make('button', 'audio-block' + (isSelected(track.id) ? ' selected' : ''), assetFor(track).name);
      button.type = 'button';
      button.style.top = `${index * 29 + 3}px`;
      button.style.left = `${total ? track.offset / total * 100 : 0}%`;
      const visibleDuration = Math.min(track.end - track.start, Math.max(0, total - track.offset));
      button.style.width = `${total ? visibleDuration / total * 100 : 0}%`;
      button.setAttribute('aria-label', `音声: ${assetFor(track).name}、${formatTime(track.offset)}から`);
      button.setAttribute('aria-pressed', String(isSelected(track.id)));
      button.addEventListener('click', () => select(track.id));
      lane.append(button);
    });
    updatePickers();
  }

  function renderInspector() {
    const track = selected();
    if (!track) return;
    const asset = assetFor(track);
    $('audio-selected-name').textContent = asset.name;
    $('audio-selected-info').textContent = `元の音声 ${formatTime(asset.duration)}`;
    $('audio-cut-duration').textContent = formatTime(track.end - track.start);
    for (const [id, value] of [['audio-trim-start', track.start], ['audio-trim-end', track.end]]) {
      $(id).value = round(value);
      $(id).max = round(asset.duration);
    }
    $('audio-offset').value = round(track.offset);
    $('audio-offset').max = round(Math.max(0, getDuration() - 0.05));
    $('audio-volume').value = Math.round(track.volume * 100);
    $('audio-volume-value').textContent = `${Math.round(track.volume * 100)}%`;
    $('audio-mute').setAttribute('aria-label', track.volume ? '追加音声をミュート' : '追加音声のミュートを解除');
    $('audio-mute').style.color = track.volume ? '' : 'var(--green)';
  }

  function sync(time, playing) {
    for (const track of tracks) {
      const player = players.get(track.id);
      if (!player) continue;
      player.volume = track.volume;
      const relative = time - track.offset;
      const active = relative >= 0 && relative < track.end - track.start && time < getDuration();
      if (!active) { player.pause(); continue; }
      const expected = track.start + relative;
      const tolerance = !playing || player.paused ? 0.005 : 0.2;
      if (Number.isFinite(expected) && Math.abs(player.currentTime - expected) > tolerance) {
        try { player.currentTime = expected; } catch { /* Metadata will trigger synchronization. */ }
      }
      if (playing && player.paused && !track.previewError) {
        player.play().then(() => { track.playbackBlocked = false; }).catch(error => {
          if (error.name === 'AbortError' || !players.has(track.id)) return;
          if (error.name === 'NotAllowedError') {
            if (!track.playbackBlocked) onMessage('追加音声を再生できませんでした。もう一度、再生ボタンを押してください。', true);
            track.playbackBlocked = true;
          } else if (!track.previewError) {
            track.previewError = true;
            onMessage('この音声はブラウザで再生できません。MP4への書き出しをお試しください。', true);
          }
        });
      } else if (!playing) player.pause();
    }
  }

  function change(field, value) {
    if (locked || isLocked()) return;
    const track = selected();
    if (!track || !Number.isFinite(value)) { renderInspector(); return; }
    const asset = assetFor(track);
    if (field === 'start') track.start = Math.max(0, Math.min(track.end - 0.05, value));
    if (field === 'end') track.end = Math.min(asset.duration, Math.max(track.start + 0.05, value));
    if (field === 'offset') track.offset = Math.max(0, Math.min(Math.max(0, getDuration() - 0.05), value));
    if (field === 'volume') track.volume = Math.min(1, Math.max(0, value));
    renderInspector();
    sync(getTime(), isPlaying());
    onChange();
  }

  function removeTrack(id) {
    const player = players.get(id);
    if (player) { player.pause(); player.removeAttribute('src'); player.load(); player.remove(); players.delete(id); }
    const index = tracks.findIndex(track => track.id === id);
    if (index >= 0) tracks.splice(index, 1);
    if (selectedId === id) selectedId = null;
  }

  function fitToProject() {
    const total = getDuration();
    // A shortened project keeps in-range audio, while audio beyond its new end is removed.
    for (const track of [...tracks]) if (track.offset >= total) removeTrack(track.id);
    sync(getTime(), isPlaying());
    updatePickers();
  }

  function uploadOne(file) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', `/api/audios?name=${encodeURIComponent(file.name)}`);
      request.setRequestHeader('Content-Type', 'application/octet-stream');
      request.upload.addEventListener('progress', event => {
        if (event.lengthComputable) $('audio-upload-status').textContent = `${file.name} を読み込み中… ${Math.round(event.loaded / event.total * 100)}%`;
      });
      request.addEventListener('load', () => {
        let body;
        try { body = JSON.parse(request.responseText); }
        catch { return reject(new Error('音声を読み込めませんでした。')); }
        if (request.status < 200 || request.status >= 300) return reject(new Error(body.error || '音声を読み込めませんでした。'));
        resolve(body);
      });
      request.addEventListener('error', () => reject(new Error('音声をアップロードできませんでした。接続を確認してください。')));
      request.send(file);
    });
  }

  async function uploadFiles(files) {
    if (locked || isLocked() || uploading || getDuration() <= 0) return;
    uploading = true;
    $('audio-upload-status').hidden = false;
    onChange();
    updatePickers();
    let count = 0;
    try {
      for (const file of Array.from(files)) {
        if (file.size > 100 * 1024 * 1024) { onMessage('音声は1ファイル100MBまでです。', true); continue; }
        if (assets.length >= 20) { onMessage('音声素材は最大20本までです。', true); break; }
        try {
          const asset = await uploadOne(file);
          assets.push(asset);
          renderLibrary();
          addTrack(asset);
          count++;
        } catch (error) { onMessage(error.message, true); }
      }
    } finally {
      uploading = false;
      $('audio-upload-status').hidden = true;
      document.querySelectorAll('.audio-file-input').forEach(input => { input.value = ''; });
      onChange();
      updatePickers();
    }
    if (count) onMessage(`${count}本の音声を追加しました。`);
  }

  document.addEventListener('change', event => {
    if (event.target.matches('.audio-file-input')) uploadFiles(event.target.files);
  });
  for (const [id, field] of [['audio-trim-start', 'start'], ['audio-trim-end', 'end'], ['audio-offset', 'offset']]) {
    $(id).addEventListener('change', event => change(field, Number(event.target.value)));
  }
  $('audio-volume').addEventListener('input', event => change('volume', Number(event.target.value) / 100));
  $('audio-mute').addEventListener('click', () => { const track = selected(); if (track) change('volume', track.volume ? 0 : 0.5); });
  $('remove-audio').addEventListener('click', () => {
    if (locked || isLocked() || !selected()) return;
    removeTrack(selectedId);
    onChange();
    onSelect(null, getTime());
  });
  renderLibrary();

  return {
    get uploading() { return uploading; },
    get selected() { return selected(); },
    get count() { return tracks.length; },
    renderTimeline, renderInspector, sync, fitToProject, updatePickers,
    exportTracks: () => tracks.map(({ audioId, start, end, offset, volume }) => ({ audioId, start, end, offset, volume })),
    setLocked(value) {
      locked = value;
      document.querySelectorAll('#audio-inspector input, #audio-inspector button, #audio-library button').forEach(node => { node.disabled = value; });
      updatePickers();
    },
  };
}
