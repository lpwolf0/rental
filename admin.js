// Admin dashboard for cars + categories. Talks straight to your Supabase project.
// Login = Supabase Auth (single admin). What you may change is enforced by the database
// rules in supabase/setup.sql, not by this page, so a visitor cannot bypass it.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const SESSION_KEY = 'xc_admin_session';
  const BUCKET = 'car-images';

  const views = { setup: $('viewSetup'), login: $('viewLogin'), app: $('viewApp') };
  function show(name) { Object.entries(views).forEach(([k, el]) => (el.hidden = k !== name)); }

  if (!SUPABASE_URL || !SUPABASE_KEY) { show('setup'); return; }

  // ---------------------------------------------------------------- session + API
  let session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) {}
  const saveSession = s => {
    session = s;
    try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch (e) {}
  };
  const toSession = d => ({
    access_token: d.access_token, refresh_token: d.refresh_token,
    expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
    email: d.user && d.user.email
  });

  async function errorFrom(res) {
    let d = {};
    try { d = await res.json(); } catch (e) {}
    const msg = d.message || d.msg || d.error_description || d.error || ('Request failed (' + res.status + ')');
    const err = new Error(msg); err.status = res.status; err.code = d.code; return err;
  }

  async function refresh() {
    if (!session || !session.refresh_token) throw new Error('Please log in again.');
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST', headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!res.ok) { saveSession(null); throw new Error('Your session expired. Please log in again.'); }
    saveSession(Object.assign(toSession(await res.json()), { email: session.email }));
  }

  // One place for every request: adds the keys, renews the login if it is about to expire.
  async function api(path, opts = {}) {
    if (!session) throw new Error('Please log in again.');
    if (session.expires_at - 60 < Date.now() / 1000) await refresh();
    const send = () => fetch(SUPABASE_URL + path, {
      method: opts.method || 'GET',
      headers: Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + session.access_token }, opts.headers || {}),
      body: opts.body
    });
    let res = await send();
    if (res.status === 401) { await refresh(); res = await send(); }
    if (!res.ok) throw await errorFrom(res);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  const rest = (path, method, obj, prefer) => api('/rest/v1/' + path, {
    method, body: obj === undefined ? undefined : JSON.stringify(obj),
    headers: Object.assign({ 'Content-Type': 'application/json' }, prefer ? { Prefer: prefer } : {})
  });

  function friendly(err) {
    if (err.status === 403 || err.code === '42501') return 'This account is not allowed to change data. Check that the email in setup.sql matches the one you logged in with.';
    if (/Failed to fetch|NetworkError/i.test(err.message)) return 'Could not reach Supabase. Check your internet connection and try again.';
    return err.message;
  }

  // ---------------------------------------------------------------- login / logout
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('loginMsg'), btn = $('loginBtn');
    msg.textContent = '';
    if (!$('email').value || !$('password').value) { msg.textContent = 'Enter your email and password.'; return; }
    btn.disabled = true; btn.textContent = 'Logging in...';
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value })
      });
      if (!res.ok) { const er = await errorFrom(res); throw new Error(/invalid/i.test(er.message) ? 'Wrong email or password.' : er.message); }
      saveSession(toSession(await res.json()));
      $('password').value = '';
      await start();
    } catch (err) { msg.textContent = friendly(err); }
    btn.disabled = false; btn.textContent = 'Log in';
  });

  $('logoutBtn').addEventListener('click', async () => {
    try { await api('/auth/v1/logout', { method: 'POST' }); } catch (e) {}
    saveSession(null); show('login');
  });

  // ---------------------------------------------------------------- state + loading
  let cars = [], cats = [];
  const appMsg = t => { $('appMsg').textContent = t || ''; };

  async function load() {
    [cars, cats] = await Promise.all([
      rest('cars?select=*&order=sort_order.asc,id.asc', 'GET'),
      rest('categories?select=*&order=sort_order.asc,name.asc', 'GET')
    ]);
    renderCars(); renderCats();
  }

  async function start() {
    appMsg('');
    try {
      await load();
      show('app');
    } catch (err) {
      if (/log in again|expired/i.test(err.message)) { show('login'); $('loginMsg').textContent = err.message; }
      else { show('app'); appMsg(friendly(err)); }
    }
  }

  // ---------------------------------------------------------------- helpers
  const photoUrl = (c, thumb) => {
    const p = thumb ? c.thumb_path : c.image_path;
    if (p) return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${p}`;
    return c.legacy_img ? 'images/cars/' + (thumb ? c.legacy_img : c.legacy_img.replace('thumb_', '')) : '';
  };
  const catName = slug => (cats.find(c => c.slug === slug) || { name: slug }).name;
  const slugify = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const nextOrder = list => list.reduce((m, x) => Math.max(m, x.sort_order || 0), 0) + 10;
  function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = on ? label.busy : label.idle; }

  // ---------------------------------------------------------------- cars list
  function renderCars() {
    const shown = cars.filter(c => c.visible).length;
    $('carsSummary').textContent = cars.length ? `${cars.length} car${cars.length === 1 ? '' : 's'}, ${shown} showing on the website` : '';
    const box = $('carsList');
    if (!cars.length) { box.innerHTML = '<div class="empty-box">No cars yet. Click <strong>+ Add a car</strong> to add your first one.</div>'; return; }
    box.innerHTML = cars.map((c, i) => {
      const catChips = (c.categories || []).map(s => `<span class="chip-s">${esc(catName(s))}</span>`).join('') || '<span class="chip-s warn">No category</span>';
      const price = c.price != null ? '&#8358;' + Number(c.price).toLocaleString() + ' / day' : 'Price on request';
      const img = photoUrl(c, true);
      return `<article class="row-card${c.visible ? '' : ' is-hidden'}" data-id="${c.id}">
        <div class="row-thumb">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ''}</div>
        <div>
          <p class="row-title">${esc(c.name)}${c.visible ? '' : ' <span class="chip-s warn">Hidden</span>'}</p>
          <p class="row-meta">${esc(c.year)} &middot; ${esc(c.seats)} seats &middot; ${esc(c.fuel)} &middot; ${price}</p>
          <div class="chips">${catChips}</div>
        </div>
        <div class="row-actions">
          <label class="switch" title="Show on website"><input type="checkbox" data-act="toggle" ${c.visible ? 'checked' : ''} aria-label="Show ${esc(c.name)} on the website"><span></span></label>
          <button class="icon-btn" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up" title="Move up">&uarr;</button>
          <button class="icon-btn" data-act="down" ${i === cars.length - 1 ? 'disabled' : ''} aria-label="Move down" title="Move down">&darr;</button>
          <button class="btn btn-outline btn-sm" data-act="edit">Edit</button>
          <button class="btn btn-outline btn-sm btn-danger" data-act="delete">Delete</button>
        </div>
      </article>`;
    }).join('');
  }

  $('carsList').addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const card = btn.closest('[data-id]'); const car = cars.find(c => String(c.id) === card.dataset.id);
    const act = btn.dataset.act; appMsg('');
    try {
      if (act === 'edit') openCar(car);
      else if (act === 'toggle') { await rest(`cars?id=eq.${car.id}`, 'PATCH', { visible: btn.checked }); car.visible = btn.checked; renderCars(); }
      else if (act === 'up' || act === 'down') await move(car, act === 'up' ? -1 : 1);
      else if (act === 'delete') await removeCar(car);
    } catch (err) { appMsg(friendly(err)); await load().catch(() => {}); }
  });

  // Re-number everything 10, 20, 30... so moving is always exact
  async function move(car, dir) {
    const i = cars.indexOf(car), j = i + dir;
    if (j < 0 || j >= cars.length) return;
    const list = cars.slice(); list.splice(i, 1); list.splice(j, 0, car);
    const changes = [];
    list.forEach((c, n) => { const o = (n + 1) * 10; if (c.sort_order !== o) { changes.push(rest(`cars?id=eq.${c.id}`, 'PATCH', { sort_order: o })); c.sort_order = o; } });
    await Promise.all(changes);
    cars = list; renderCars();
  }

  async function removeCar(car) {
    if (!confirm(`Delete "${car.name}" permanently?\n\nTo remove it from the website but keep it, use the switch instead.`)) return;
    await rest(`cars?id=eq.${car.id}`, 'DELETE');
    await deletePhotos([car.image_path, car.thumb_path]);
    await load();
  }

  async function deletePhotos(paths) {
    const prefixes = paths.filter(Boolean);
    if (!prefixes.length) return;
    try { await api(`/storage/v1/object/${BUCKET}`, { method: 'DELETE', body: JSON.stringify({ prefixes }), headers: { 'Content-Type': 'application/json' } }); } catch (e) { /* leftover file is harmless */ }
  }

  // ---------------------------------------------------------------- car form
  const carDlg = $('carDialog'), carForm = $('carForm');
  let editing = null, pickedFile = null;

  function setPreview(src) { $('photoPreview').innerHTML = src ? `<img src="${esc(src)}" alt="Photo preview">` : '<span>No photo</span>'; }

  function openCar(car) {
    editing = car || null; pickedFile = null; $('carMsg').textContent = '';
    $('carDialogTitle').textContent = car ? 'Edit car' : 'Add a car';
    $('fName').value = car ? car.name : '';
    $('fYear').value = car ? car.year : new Date().getFullYear();
    $('fSeats').value = car ? car.seats : 5;
    $('fFuel').value = car ? car.fuel : 'Petrol';
    $('fPrice').value = car && car.price != null ? car.price : '';
    $('fOrder').value = car ? car.sort_order : nextOrder(cars);
    $('fVisible').checked = car ? car.visible : true;
    $('fPhoto').value = '';
    $('photoReq').hidden = !!(car && photoUrl(car));
    setPreview(car ? photoUrl(car, false) : '');
    $('fCats').innerHTML = cats.length
      ? cats.map(c => `<label><input type="checkbox" value="${esc(c.slug)}" ${car && (car.categories || []).includes(c.slug) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')
      : '<span class="muted">Create a category first (Categories tab).</span>';
    carDlg.showModal();
    $('fName').focus();
  }
  $('addCarBtn').addEventListener('click', () => { if (!cats.length) { appMsg('Create at least one category first (Categories tab).'); return; } openCar(null); });

  $('fPhoto').addEventListener('change', () => {
    const f = $('fPhoto').files[0]; $('carMsg').textContent = '';
    if (!f) { pickedFile = null; setPreview(editing ? photoUrl(editing, false) : ''); return; }
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { $('carMsg').textContent = 'Please choose a PNG, JPG or WebP image.'; $('fPhoto').value = ''; return; }
    if (f.size > 15 * 1024 * 1024) { $('carMsg').textContent = 'That image is over 15 MB. Please choose a smaller one.'; $('fPhoto').value = ''; return; }
    pickedFile = f; setPreview(URL.createObjectURL(f));
  });

  // Shrink the photo in the browser: one for the details page, a smaller one for cards.
  async function resize(file, maxW) {
    let bmp;
    if (window.createImageBitmap) bmp = await createImageBitmap(file);
    else bmp = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = URL.createObjectURL(file); });
    const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
    const scale = Math.min(1, maxW / w);
    const c = document.createElement('canvas'); c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.85));
    if (!blob) throw new Error('Could not process that image. Try a different file.');
    return blob;
  }
  async function upload(path, blob) {
    await api(`/storage/v1/object/${BUCKET}/${path}`, { method: 'POST', body: blob, headers: { 'Content-Type': blob.type || 'image/webp', 'x-upsert': 'true', 'cache-control': 'max-age=31536000' } });
  }
  const extOf = blob => (blob.type === 'image/webp' ? 'webp' : blob.type === 'image/png' ? 'png' : 'jpg');

  carForm.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('carMsg'), btn = $('carSaveBtn'); msg.textContent = '';
    const name = $('fName').value.trim(), year = Number($('fYear').value), seats = Number($('fSeats').value);
    const chosen = [...$('fCats').querySelectorAll('input:checked')].map(i => i.value);
    const priceTxt = $('fPrice').value.trim();
    if (!name) return void (msg.textContent = 'Enter the car name.');
    if (!year || year < 1990) return void (msg.textContent = 'Enter a valid year.');
    if (!seats || seats < 1) return void (msg.textContent = 'Enter the number of seats.');
    if (!chosen.length) return void (msg.textContent = 'Pick at least one category.');
    if (priceTxt !== '' && (isNaN(Number(priceTxt)) || Number(priceTxt) < 0)) return void (msg.textContent = 'Price must be a number, or empty.');
    if (!editing && !pickedFile) return void (msg.textContent = 'Please add a photo of the car.');

    const row = {
      name, year, seats, fuel: $('fFuel').value, price: priceTxt === '' ? null : Number(priceTxt),
      categories: chosen, visible: $('fVisible').checked, sort_order: Number($('fOrder').value) || nextOrder(cars)
    };
    const L = { busy: 'Saving...', idle: 'Save car' };
    busy(btn, true, L);
    const oldPaths = editing ? [editing.image_path, editing.thumb_path] : [];
    const newPaths = [];
    try {
      if (pickedFile) {
        const [full, thumb] = await Promise.all([resize(pickedFile, 900), resize(pickedFile, 480)]);
        const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        row.image_path = `cars/${stamp}.${extOf(full)}`; row.thumb_path = `cars/thumb_${stamp}.${extOf(thumb)}`;
        await upload(row.image_path, full); newPaths.push(row.image_path);
        await upload(row.thumb_path, thumb); newPaths.push(row.thumb_path);
      }
      if (editing) await rest(`cars?id=eq.${editing.id}`, 'PATCH', row);
      else await rest('cars', 'POST', row, 'return=minimal');
      if (pickedFile && editing) await deletePhotos(oldPaths);
      carDlg.close();
      await load();
    } catch (err) {
      await deletePhotos(newPaths);        // do not leave orphan uploads behind
      msg.textContent = friendly(err);
    }
    busy(btn, false, L);
  });

  // ---------------------------------------------------------------- categories
  function renderCats() {
    const box = $('catsList');
    if (!cats.length) { box.innerHTML = '<div class="empty-box">No categories yet. Click <strong>+ Add a category</strong>.</div>'; return; }
    box.innerHTML = cats.map(c => {
      const n = cars.filter(x => (x.categories || []).includes(c.slug)).length;
      return `<article class="row-card is-cat" data-slug="${esc(c.slug)}">
        <div>
          <p class="row-title">${esc(c.name)}</p>
          <p class="row-meta">${n} car${n === 1 ? '' : 's'} &middot; badge: ${esc(c.label || c.name)} &middot; id: ${esc(c.slug)}</p>
        </div>
        <div class="row-actions">
          <button class="btn btn-outline btn-sm" data-act="edit">Edit</button>
          <button class="btn btn-outline btn-sm btn-danger" data-act="delete">Delete</button>
        </div>
      </article>`;
    }).join('');
  }

  const catDlg = $('catDialog'), catForm = $('catForm');
  let editingCat = null;
  function openCat(cat) {
    editingCat = cat || null; $('catMsg').textContent = '';
    $('catDialogTitle').textContent = cat ? 'Edit category' : 'Add a category';
    $('cName').value = cat ? cat.name : ''; $('cLabel').value = cat ? (cat.label || '') : '';
    $('cOrder').value = cat ? cat.sort_order : nextOrder(cats);
    catDlg.showModal(); $('cName').focus();
  }
  $('addCatBtn').addEventListener('click', () => openCat(null));

  $('catsList').addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const cat = cats.find(c => c.slug === btn.closest('[data-slug]').dataset.slug); appMsg('');
    if (btn.dataset.act === 'edit') return openCat(cat);
    const n = cars.filter(x => (x.categories || []).includes(cat.slug)).length;
    if (n) { appMsg(`"${cat.name}" is used by ${n} car${n === 1 ? '' : 's'}. Remove it from those cars first (or move them to another category), then delete it.`); return; }
    if (!confirm(`Delete the category "${cat.name}"?`)) return;
    try { await rest(`categories?slug=eq.${encodeURIComponent(cat.slug)}`, 'DELETE'); await load(); } catch (err) { appMsg(friendly(err)); }
  });

  catForm.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('catMsg'), btn = $('catSaveBtn'); msg.textContent = '';
    const name = $('cName').value.trim();
    if (!name) return void (msg.textContent = 'Enter a name.');
    const row = { name, label: $('cLabel').value.trim() || null, sort_order: Number($('cOrder').value) || nextOrder(cats) };
    const L = { busy: 'Saving...', idle: 'Save' }; busy(btn, true, L);
    try {
      if (editingCat) await rest(`categories?slug=eq.${encodeURIComponent(editingCat.slug)}`, 'PATCH', row);
      else {
        const slug = slugify(name);
        if (!slug) throw new Error('Please use letters or numbers in the name.');
        if (cats.some(c => c.slug === slug)) throw new Error('A category with that name already exists.');
        await rest('categories', 'POST', Object.assign({ slug }, row), 'return=minimal');
      }
      catDlg.close(); await load();
    } catch (err) { msg.textContent = friendly(err); }
    busy(btn, false, L);
  });

  // ---------------------------------------------------------------- tabs + dialogs
  document.querySelectorAll('.admin-tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.admin-tab').forEach(x => x.classList.toggle('active', x === t));
    $('tabCars').hidden = t.dataset.tab !== 'cars'; $('tabCats').hidden = t.dataset.tab !== 'cats'; appMsg('');
  }));
  document.querySelectorAll('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('mousedown', e => { if (e.target === d) d.close(); }));

  // ---------------------------------------------------------------- go
  if (session) start(); else show('login');
})();
