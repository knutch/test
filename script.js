const folderForm = document.getElementById('folder-form');
const folderNameInput = document.getElementById('folder-name');
const folderList = document.getElementById('folder-list');
const activeFolderTitle = document.getElementById('active-folder-title');
const photoInput = document.getElementById('photo-input');
const albumGrid = document.getElementById('album-grid');
const message = document.getElementById('message');
const photoTemplate = document.getElementById('photo-card-template');

const folders = [];
let activeFolderId = null;

const map = L.map('map').setView([51.1657, 10.4515], 5);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const markersLayer = L.layerGroup().addTo(map);

function setMessage(text) {
  message.textContent = text;
}

function renderFolders() {
  folderList.innerHTML = '';

  folders.forEach((folder) => {
    const li = document.createElement('li');
    li.className = `folder-item ${folder.id === activeFolderId ? 'active' : ''}`;
    li.textContent = `${folder.name} (${folder.photos.length})`;
    li.addEventListener('click', () => {
      activeFolderId = folder.id;
      renderFolders();
      renderActiveFolder();
    });
    folderList.appendChild(li);
  });
}

function renderActiveFolder() {
  const activeFolder = folders.find((folder) => folder.id === activeFolderId);

  if (!activeFolder) {
    activeFolderTitle.textContent = 'Kein Ordner ausgewählt';
    albumGrid.innerHTML = '';
    photoInput.disabled = true;
    markersLayer.clearLayers();
    return;
  }

  activeFolderTitle.textContent = `Ordner: ${activeFolder.name}`;
  photoInput.disabled = false;
  albumGrid.innerHTML = '';
  markersLayer.clearLayers();

  const points = [];

  activeFolder.photos.forEach((photo) => {
    const fragment = photoTemplate.content.cloneNode(true);
    const img = fragment.querySelector('img');
    const name = fragment.querySelector('.photo-name');
    const location = fragment.querySelector('.photo-location');

    img.src = photo.preview;
    img.alt = photo.name;
    name.textContent = photo.name;

    if (photo.coordinates) {
      const { lat, lng } = photo.coordinates;
      location.textContent = `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      points.push([lat, lng]);

      L.marker([lat, lng])
        .bindPopup(`<strong>${photo.name}</strong>`)
        .addTo(markersLayer);
    } else {
      location.textContent = 'Keine GPS-Daten gefunden';
    }

    albumGrid.appendChild(fragment);
  });

  if (points.length === 1) {
    map.setView(points[0], 12);
  } else if (points.length > 1) {
    map.fitBounds(points, { padding: [30, 30] });
  }
}

folderForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = folderNameInput.value.trim();

  if (!name) {
    return;
  }

  const folder = {
    id: crypto.randomUUID(),
    name,
    photos: [],
  };

  folders.push(folder);
  activeFolderId = folder.id;
  folderNameInput.value = '';
  setMessage(`Ordner „${name}“ wurde erstellt.`);

  renderFolders();
  renderActiveFolder();
});

photoInput.addEventListener('change', async (event) => {
  const files = Array.from(event.target.files || []);
  const activeFolder = folders.find((folder) => folder.id === activeFolderId);

  if (!activeFolder || files.length === 0) {
    return;
  }

  setMessage(`Lese ${files.length} Foto(s) ...`);

  for (const file of files) {
    const preview = URL.createObjectURL(file);
    const arrayBuffer = await file.arrayBuffer();
    const coordinates = extractGpsFromExif(arrayBuffer);

    activeFolder.photos.push({
      name: file.name,
      preview,
      coordinates,
    });
  }

  photoInput.value = '';
  setMessage(`${files.length} Foto(s) zum Ordner „${activeFolder.name}“ hinzugefügt.`);
  renderFolders();
  renderActiveFolder();
});

function extractGpsFromExif(arrayBuffer) {
  const dataView = new DataView(arrayBuffer);

  if (dataView.getUint16(0) !== 0xffd8) {
    return null;
  }

  let offset = 2;

  while (offset < dataView.byteLength) {
    const marker = dataView.getUint16(offset);
    offset += 2;

    if (marker === 0xffe1) {
      const segmentLength = dataView.getUint16(offset);
      offset += 2;

      if (getString(dataView, offset, 4) !== 'Exif') {
        offset += segmentLength - 2;
        continue;
      }

      const tiffOffset = offset + 6;
      const littleEndian = getString(dataView, tiffOffset, 2) === 'II';
      const firstIfdOffset = dataView.getUint32(tiffOffset + 4, littleEndian);
      const gpsPointer = readIfdTagValue(
        dataView,
        tiffOffset + firstIfdOffset,
        tiffOffset,
        0x8825,
        littleEndian
      );

      if (!gpsPointer) {
        return null;
      }

      const gpsIfdOffset = tiffOffset + gpsPointer;
      const latRef = readGpsAsciiTag(dataView, gpsIfdOffset, tiffOffset, 0x0001, littleEndian);
      const lat = readGpsRationalTag(dataView, gpsIfdOffset, tiffOffset, 0x0002, littleEndian);
      const lngRef = readGpsAsciiTag(dataView, gpsIfdOffset, tiffOffset, 0x0003, littleEndian);
      const lng = readGpsRationalTag(dataView, gpsIfdOffset, tiffOffset, 0x0004, littleEndian);

      if (!latRef || !lngRef || !lat || !lng) {
        return null;
      }

      return {
        lat: convertToDecimal(lat, latRef),
        lng: convertToDecimal(lng, lngRef),
      };
    }

    if ((marker & 0xff00) !== 0xff00) {
      break;
    }

    const length = dataView.getUint16(offset);
    offset += length;
  }

  return null;
}

function readIfdTagValue(view, ifdOffset, tiffOffset, tagToFind, littleEndian) {
  const entryCount = view.getUint16(ifdOffset, littleEndian);

  for (let i = 0; i < entryCount; i += 1) {
    const entryOffset = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(entryOffset, littleEndian);

    if (tag === tagToFind) {
      return view.getUint32(entryOffset + 8, littleEndian);
    }
  }

  return null;
}

function readGpsAsciiTag(view, gpsIfdOffset, tiffOffset, tagToFind, littleEndian) {
  const entryCount = view.getUint16(gpsIfdOffset, littleEndian);

  for (let i = 0; i < entryCount; i += 1) {
    const entryOffset = gpsIfdOffset + 2 + i * 12;
    const tag = view.getUint16(entryOffset, littleEndian);

    if (tag === tagToFind) {
      const count = view.getUint32(entryOffset + 4, littleEndian);
      const valueOffset = view.getUint32(entryOffset + 8, littleEndian);
      return getString(view, tiffOffset + valueOffset, count).replace(/\0/g, '');
    }
  }

  return null;
}

function readGpsRationalTag(view, gpsIfdOffset, tiffOffset, tagToFind, littleEndian) {
  const entryCount = view.getUint16(gpsIfdOffset, littleEndian);

  for (let i = 0; i < entryCount; i += 1) {
    const entryOffset = gpsIfdOffset + 2 + i * 12;
    const tag = view.getUint16(entryOffset, littleEndian);

    if (tag === tagToFind) {
      const valueOffset = view.getUint32(entryOffset + 8, littleEndian);
      const rationals = [];

      for (let part = 0; part < 3; part += 1) {
        const offset = tiffOffset + valueOffset + part * 8;
        const numerator = view.getUint32(offset, littleEndian);
        const denominator = view.getUint32(offset + 4, littleEndian);
        rationals.push(numerator / denominator);
      }

      return rationals;
    }
  }

  return null;
}

function convertToDecimal([degrees, minutes, seconds], direction) {
  const decimal = degrees + minutes / 60 + seconds / 3600;
  return direction === 'S' || direction === 'W' ? -decimal : decimal;
}

function getString(view, offset, length) {
  let result = '';

  for (let i = 0; i < length; i += 1) {
    result += String.fromCharCode(view.getUint8(offset + i));
  }

  return result;
}

renderFolders();
renderActiveFolder();
setMessage('Lege zuerst einen Ordner an und lade dann Fotos hoch.');
