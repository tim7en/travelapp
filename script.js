// Smart Travel Planner client-side logic

/*
This script powers the Smart Travel Planner. It handles user authentication,
destination lookup, itinerary creation, drag‑and‑drop editing, marker
management on the Leaflet map and data persistence using localStorage.
External data is pulled from free services via the api.allorigins.win proxy to
avoid CORS issues. In particular:
  • Geocoding is performed against geocode.maps.co.
  • Points of interest are collected from OpenStreetMap via Overpass API.
  • Descriptions are fetched from Wikipedia summaries.

Note: Because this is a demonstration application running locally, the
authentication layer is intentionally light and should not be used in
production without strengthening.
*/

document.addEventListener('DOMContentLoaded', () => {
    // DOM elements
    const loginContainer = document.getElementById('login-container');
    const loginError = document.getElementById('login-error');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const loginBtn = document.getElementById('login-btn');
    const appContainer = document.getElementById('app-container');
    const destinationInput = document.getElementById('destination-input');
    const stayLengthInput = document.getElementById('stay-length-input');
    const travelModeSelect = document.getElementById('travel-mode-select');
    const planBtn = document.getElementById('plan-btn');
    const itineraryContainer = document.getElementById('itinerary-container');
    const logoutBtn = document.getElementById('logout-btn');
    const loadingIndicator = document.getElementById('loading-indicator');

    // State variables
    let map = null;
    let markers = {};
    let places = [];
    let currentUser = localStorage.getItem('currentUser');
    let currentTripKey = null;
    let currentDest = null;
    let currentDays = null;
    let currentMode = 'driving';

    // Initialise map once the app container is shown
    function initMap() {
        if (map) return;
        map = L.map('map');
        // start with world view
        map.setView([20, 0], 2);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap contributors'
        }).addTo(map);
    }

    // Show or hide loading overlay
    function setLoading(show) {
        loadingIndicator.style.display = show ? 'block' : 'none';
    }

    // Authentication handling: sign in or register on the fly
    function handleLogin() {
        const username = usernameInput.value.trim();
        const password = passwordInput.value;
        if (!username || !password) {
            loginError.textContent = 'Please enter both username and password.';
            loginError.classList.remove('hidden');
            return;
        }
        const users = JSON.parse(localStorage.getItem('users') || '{}');
        // register new user if username does not exist
        if (!users[username]) {
            users[username] = btoa(password); // simple obfuscation
            localStorage.setItem('users', JSON.stringify(users));
        } else {
            // existing user: verify password
            if (users[username] !== btoa(password)) {
                loginError.textContent = 'Incorrect password.';
                loginError.classList.remove('hidden');
                return;
            }
        }
        // successful login
        currentUser = username;
        localStorage.setItem('currentUser', currentUser);
        loginError.classList.add('hidden');
        loginContainer.classList.add('hidden');
        appContainer.classList.remove('hidden');
        initMap();
        // if user previously planned a trip, restore it
        const storedTripMeta = localStorage.getItem(`${currentUser}_lastTrip`);
        if (storedTripMeta) {
            try {
                const meta = JSON.parse(storedTripMeta);
                currentDest = meta.dest;
                currentDays = meta.days;
                currentTripKey = `${currentUser}_trip_${currentDest}_${currentDays}`;
                currentMode = meta.mode || 'driving';
                travelModeSelect.value = currentMode;
                loadTrip();
                // center map on first POI if available
                if (places.length > 0) {
                    map.setView([places[0].lat, places[0].lon], 12);
                }
            } catch (e) {
                console.warn('Failed to parse stored trip metadata', e);
            }
        }
    }

    // Logging out simply clears current user and refreshes the page
    function handleLogout() {
        localStorage.removeItem('currentUser');
        location.reload();
    }

    // Plan a trip: geocode destination, fetch POIs, build itinerary
    async function handlePlan() {
        const dest = destinationInput.value.trim();
        const days = parseInt(stayLengthInput.value, 10);
        const mode = travelModeSelect.value;
        if (!dest) {
            alert('Please enter a destination.');
            return;
        }
        if (!days || days < 1) {
            alert('Please enter a valid number of days.');
            return;
        }
        setLoading(true);
        try {
            // geocode using geocode.maps.co via allorigins proxy to avoid CORS
            const geoUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(`https://geocode.maps.co/search?q=${encodeURIComponent(dest)}`);
            const geoRes = await fetch(geoUrl);
            const geoData = await geoRes.json();
            if (!geoData || geoData.length === 0) {
                alert('Destination not found.');
                setLoading(false);
                return;
            }
            const geocode = geoData[0];
            const lat = parseFloat(geocode.lat);
            const lon = parseFloat(geocode.lon);
            // compute search radius: 3000m per day but clamp to 10000m
            const radius = Math.min(10000, 3000 * days);
            // Overpass query for tourism attractions and related categories
            const categories = 'museum|attraction|gallery|viewpoint|zoo|aquarium|theme_park|monument|artwork|picnic_site|park';
            const query = `[out:json];node(around:${radius},${lat},${lon})[tourism~"${categories}"];out;`;
            const overpassUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query));
            const overRes = await fetch(overpassUrl);
            const overData = await overRes.json();
            let elements = (overData.elements || []).filter(el => el.tags && el.tags.name);
            // compute distance to sort
            elements.forEach(el => {
                el.distance = haversine(lat, lon, el.lat, el.lon);
            });
            elements.sort((a, b) => a.distance - b.distance);
            // determine number of POIs: up to 5 per day
            const maxPOIs = Math.min(elements.length, days * 5);
            const chosen = elements.slice(0, maxPOIs);
            places = chosen.map((el, index) => {
                const dayIndex = Math.floor(index / Math.ceil(maxPOIs / days));
                return {
                    id: el.id.toString(),
                    name: el.tags.name,
                    lat: el.lat,
                    lon: el.lon,
                    tags: el.tags,
                    day: dayIndex,
                    visited: false,
                    descriptionLoaded: false,
                    description: ''
                };
            });
            // update state
            currentDest = dest;
            currentDays = days;
            currentMode = mode;
            currentTripKey = `${currentUser}_trip_${currentDest}_${currentDays}`;
            // persist metadata for reloading later
            localStorage.setItem(`${currentUser}_lastTrip`, JSON.stringify({ dest: currentDest, days: currentDays, mode: currentMode }));
            // save entire trip
            saveTrip();
            // build UI
            createItineraryUI();
            createMarkers();
            // zoom map to area
            map.setView([lat, lon], 13);
        } catch (e) {
            console.error('Error planning trip', e);
            alert('An error occurred while planning the trip. Please try again.');
        } finally {
            setLoading(false);
        }
    }

    // Build or rebuild the itinerary UI with drag‑and‑drop lists
    function createItineraryUI() {
        itineraryContainer.innerHTML = '';
        const days = currentDays;
        if (!days) return;
        // create day containers
        for (let d = 0; d < days; d++) {
            const dayContainer = document.createElement('div');
            dayContainer.className = 'day-container';
            dayContainer.dataset.dayIndex = d;
            const header = document.createElement('div');
            header.className = 'day-header';
            const title = document.createElement('div');
            title.className = 'day-title';
            title.textContent = `Day ${d + 1}`;
            header.appendChild(title);
            dayContainer.appendChild(header);
            const list = document.createElement('div');
            list.className = 'poi-list';
            list.dataset.dayIndex = d;
            dayContainer.appendChild(list);
            itineraryContainer.appendChild(dayContainer);
        }
        // populate each day's POIs
        places.forEach(p => {
            const list = itineraryContainer.querySelector(`.poi-list[data-day-index="${p.day}"]`);
            if (!list) return;
            const item = document.createElement('div');
            item.className = 'poi-item';
            if (p.visited) item.classList.add('visited');
            item.dataset.id = p.id;
            const nameEl = document.createElement('div');
            nameEl.className = 'poi-name';
            nameEl.textContent = p.name;
            item.appendChild(nameEl);
            const toggle = document.createElement('i');
            toggle.className = 'fa fa-check-circle visit-toggle' + (p.visited ? ' visited' : '');
            toggle.title = p.visited ? 'Visited' : 'Mark as visited';
            toggle.addEventListener('click', ev => {
                ev.stopPropagation();
                toggleVisited(p.id);
            });
            item.appendChild(toggle);
            item.addEventListener('click', () => {
                // centre map and open popup
                map.flyTo([p.lat, p.lon], 15);
                if (markers[p.id]) markers[p.id].openPopup();
            });
            list.appendChild(item);
        });
        // make day containers sortable (reordering days)
        new Sortable(itineraryContainer, {
            handle: '.day-header',
            animation: 150,
            ghostClass: 'sortable-ghost',
            onEnd: evt => {
                // compute mapping from old index to new index
                const newOrderElems = Array.from(itineraryContainer.children);
                const mapping = {};
                newOrderElems.forEach((dc, newIndex) => {
                    const oldIndex = parseInt(dc.dataset.dayIndex);
                    mapping[oldIndex] = newIndex;
                    dc.dataset.dayIndex = newIndex;
                    // update list dataset too
                    const list = dc.querySelector('.poi-list');
                    list.dataset.dayIndex = newIndex;
                    // update header text
                    dc.querySelector('.day-title').textContent = `Day ${newIndex + 1}`;
                });
                // update day index in places
                places.forEach(p => {
                    p.day = mapping[p.day];
                });
                // Recreate POI lists to reflect new order
                createItineraryUI();
                // Update marker colors to reflect new days
                updateMarkerColors();
                saveTrip();
            }
        });
        // make each POI list sortable and allow drag across lists
        Array.from(itineraryContainer.querySelectorAll('.poi-list')).forEach(list => {
            new Sortable(list, {
                group: 'shared-pois',
                handle: '.poi-item',
                animation: 150,
                onEnd: evt => {
                    const itemEl = evt.item;
                    const poiId = itemEl.dataset.id;
                    const newDayIndex = parseInt(evt.to.dataset.dayIndex);
                    const poi = places.find(pl => pl.id === poiId);
                    if (!poi) return;
                    poi.day = newDayIndex;
                    // update marker color
                    updateMarkerColors();
                    saveTrip();
                }
            });
        });
    }

    // Create markers on map for current places
    function createMarkers() {
        // remove existing markers
        if (markers && Object.keys(markers).length > 0) {
            Object.values(markers).forEach(m => map.removeLayer(m));
        }
        markers = {};
        const dayColors = ['#e74c3c', '#3498db', '#27ae60', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#8e44ad'];
        places.forEach(p => {
            if (p.visited) return;
            const color = dayColors[p.day % dayColors.length];
            // create a simple coloured circle as DivIcon
            const icon = L.divIcon({
                html: `<div style="background-color:${color};width:18px;height:18px;border-radius:9px;border:2px solid #fff;"></div>`,
                className: ''
            });
            const marker = L.marker([p.lat, p.lon], { icon });
            marker.addTo(map);
            marker.on('click', () => {
                showPlacePopup(p);
            });
            markers[p.id] = marker;
        });
    }

    // Update marker colours and visibility when days change or places visited
    function updateMarkerColors() {
        const dayColors = ['#e74c3c', '#3498db', '#27ae60', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#8e44ad'];
        places.forEach(p => {
            const marker = markers[p.id];
            // if marker exists
            if (marker) {
                if (p.visited) {
                    map.removeLayer(marker);
                    delete markers[p.id];
                } else {
                    const color = dayColors[p.day % dayColors.length];
                    const icon = L.divIcon({
                        html: `<div style="background-color:${color};width:18px;height:18px;border-radius:9px;border:2px solid #fff;"></div>`,
                        className: ''
                    });
                    marker.setIcon(icon);
                }
            }
        });
    }

    // Show a popup for a place when the marker is clicked
    function showPlacePopup(p) {
        const marker = markers[p.id];
        if (!marker) return;
        const popupContent = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = p.name;
        popupContent.appendChild(title);
        const desc = document.createElement('p');
        desc.textContent = p.description || 'Loading description…';
        popupContent.appendChild(desc);
        const visitBtn = document.createElement('button');
        visitBtn.textContent = p.visited ? 'Visited' : 'Mark as visited';
        visitBtn.disabled = p.visited;
        visitBtn.style.marginTop = '8px';
        visitBtn.style.backgroundColor = '#3f51b5';
        visitBtn.style.color = '#fff';
        visitBtn.style.border = 'none';
        visitBtn.style.padding = '6px 10px';
        visitBtn.style.borderRadius = '4px';
        visitBtn.style.cursor = p.visited ? 'default' : 'pointer';
        visitBtn.addEventListener('click', () => {
            toggleVisited(p.id);
            marker.closePopup();
        });
        popupContent.appendChild(visitBtn);
        marker.bindPopup(popupContent);
        marker.openPopup();
        // fetch description once if not loaded
        if (!p.descriptionLoaded) {
            fetchWikipediaSummary(p.name).then(summary => {
                p.description = summary || 'No description available.';
                desc.textContent = p.description;
                p.descriptionLoaded = true;
            }).catch(() => {
                p.description = 'No description available.';
                desc.textContent = p.description;
                p.descriptionLoaded = true;
            });
        }
    }

    // Fetch summary from Wikipedia via allorigins proxy
    async function fetchWikipediaSummary(title) {
        try {
            const url = 'https://api.allorigins.win/raw?url=' + encodeURIComponent('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')));
            const res = await fetch(url);
            if (!res.ok) throw new Error('Fetch failed');
            const data = await res.json();
            return data.extract || '';
        } catch (e) {
            console.warn('Wikipedia summary fetch failed for', title, e);
            return '';
        }
    }

    // Mark/unmark a place as visited and update UI/state
    function toggleVisited(id) {
        const p = places.find(pl => pl.id === id);
        if (!p) return;
        p.visited = !p.visited;
        // update itinerary item class and icon
        const item = itineraryContainer.querySelector(`.poi-item[data-id="${id}"]`);
        if (item) {
            if (p.visited) {
                item.classList.add('visited');
                const icon = item.querySelector('.visit-toggle');
                icon.classList.add('visited');
                icon.title = 'Visited';
            } else {
                item.classList.remove('visited');
                const icon = item.querySelector('.visit-toggle');
                icon.classList.remove('visited');
                icon.title = 'Mark as visited';
            }
        }
        updateMarkerColors();
        saveTrip();
    }

    // Persist current trip state to localStorage
    function saveTrip() {
        if (!currentTripKey) return;
        const data = { places: places, dest: currentDest, days: currentDays, mode: currentMode };
        localStorage.setItem(currentTripKey, JSON.stringify(data));
    }

    // Load trip from localStorage if available
    function loadTrip() {
        if (!currentTripKey) return;
        const dataStr = localStorage.getItem(currentTripKey);
        if (!dataStr) return;
        try {
            const data = JSON.parse(dataStr);
            places = data.places || [];
            currentDest = data.dest;
            currentDays = data.days;
            currentMode = data.mode || 'driving';
            stayLengthInput.value = currentDays;
            travelModeSelect.value = currentMode;
            destinationInput.value = currentDest;
            createItineraryUI();
            createMarkers();
        } catch (e) {
            console.warn('Failed to load trip data', e);
        }
    }

    // Haversine distance calculation (km)
    function haversine(lat1, lon1, lat2, lon2) {
        const R = 6371; // earth radius in km
        const toRad = deg => deg * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    // Event listeners
    loginBtn.addEventListener('click', handleLogin);
    logoutBtn.addEventListener('click', handleLogout);
    planBtn.addEventListener('click', handlePlan);
    travelModeSelect.addEventListener('change', () => {
        currentMode = travelModeSelect.value;
        // Save mode to metadata
        if (currentUser && currentDest) {
            localStorage.setItem(`${currentUser}_lastTrip`, JSON.stringify({ dest: currentDest, days: currentDays, mode: currentMode }));
        }
    });

    // If a user is already logged in, skip login page
    if (currentUser) {
        loginContainer.classList.add('hidden');
        appContainer.classList.remove('hidden');
        initMap();
        // try restore last trip meta
        const metaStr = localStorage.getItem(`${currentUser}_lastTrip`);
        if (metaStr) {
            try {
                const meta = JSON.parse(metaStr);
                currentDest = meta.dest;
                currentDays = meta.days;
                currentMode = meta.mode || 'driving';
                currentTripKey = `${currentUser}_trip_${currentDest}_${currentDays}`;
                destinationInput.value = currentDest;
                stayLengthInput.value = currentDays;
                travelModeSelect.value = currentMode;
                loadTrip();
                if (places.length > 0) {
                    map.setView([places[0].lat, places[0].lon], 12);
                }
            } catch (e) {
                console.warn('Failed to parse last trip meta');
            }
        }
    }
});