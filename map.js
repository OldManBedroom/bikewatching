// Set your Mapbox access token here
mapboxgl.accessToken =
  'pk.eyJ1IjoiYmVkcm9vbSIsImEiOiJjbTdmZ2Y1dnMwMXhtMndweXUxOWR0aDFzIn0.B8dDJgohfPFZ4GFCse9OqA';

// Declare filterTripsByTime early so it exists for updateTimeDisplay()
let filterTripsByTime = function() {};

// Global filtering variables and DOM element selections
let timeFilter = -1; // -1 means no filtering
const timeSlider = document.getElementById('time-slider');
const selectedTime = document.getElementById('selected-time');
const anyTimeLabel = document.getElementById('any-time');

// Helper: Format minutes as HH:MM AM/PM
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

// Helper: Get minutes since midnight from a Date object
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// Update the slider display and trigger filtering
function updateTimeDisplay() {
  timeFilter = Number(timeSlider.value);
  if (timeFilter === -1) {
    selectedTime.textContent = '';
    anyTimeLabel.style.display = 'block';
  } else {
    selectedTime.textContent = formatTime(timeFilter);
    anyTimeLabel.style.display = 'none';
  }
  if (typeof filterTripsByTime === "function") {
    filterTripsByTime();
  }
}

timeSlider.addEventListener('input', updateTimeDisplay);
updateTimeDisplay(); // Initialize display

// Define a quantize scale for station flow (ratio of departures/total)
const stationFlow = d3.scaleQuantize()
  .domain([0, 1])
  .range([0, 0.5, 1]);

// Initialize the map
const map = new mapboxgl.Map({
  container: 'map', // The div where the map will render
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 5,
  maxZoom: 18
});

// Global variables to store station/trip data and SVG circles
let stations, trips;
let circles;
let filteredStations = [];

// When the map loads, add bike lane layers and load station & traffic data
map.on('load', () => {
  // --- Add Bike Lane Layers ---
  // Boston Bike Lanes
  map.addSource('boston_route', {
    type: 'geojson',
    data:
      'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson'
  });
  map.addLayer({
    id: 'bike-lanes-boston',
    type: 'line',
    source: 'boston_route',
    paint: {
      'line-color': '#32D400',
      'line-width': 5,
      'line-opacity': 0.6
    }
  });

  // Cambridge Bike Lanes
  map.addSource('cambridge_route', {
    type: 'geojson',
    data:
      'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson'
  });
  map.addLayer({
    id: 'bike-lanes-cambridge',
    type: 'line',
    source: 'cambridge_route',
    paint: {
      'line-color': '#32D400',
      'line-width': 5,
      'line-opacity': 0.6
    }
  });

  // --- Load Station and Traffic Data ---
  Promise.all([
    d3.json('https://dsc106.com/labs/lab07/data/bluebikes-stations.json'),
    d3.csv('https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv')
  ])
    .then(([stationData, tripData]) => {
      // Process station data (assumed to be in stationData.data.stations)
      stations = stationData.data.stations;

      // Process trip data: convert start and end times to Date objects
      trips = tripData;
      for (let trip of trips) {
        trip.started_at = new Date(trip.started_at);
        trip.ended_at = new Date(trip.ended_at);
      }

      // Compute overall traffic using d3.rollup
      let overallDepartures = d3.rollup(
        trips,
        v => v.length,
        d => d.start_station_id
      );
      let overallArrivals = d3.rollup(
        trips,
        v => v.length,
        d => d.end_station_id
      );

      // Append overall traffic properties to each station.
      // We assume station.short_name uniquely identifies the station.
      stations = stations.map(station => {
        let id = station.short_name;
        station.departures = overallDepartures.get(id) ?? 0;
        station.arrivals = overallArrivals.get(id) ?? 0;
        station.totalTraffic = station.departures + station.arrivals;
        return station;
      });
      console.log('Stations with overall traffic:', stations);

      // Create circles for each station using overall traffic.
      const svg = d3.select('#map').select('svg');
      circles = svg.selectAll('circle')
        .data(stations)
        .enter()
        .append('circle')
        .attr('r', d => {
          // Base radius scale: overall range [0, 25]
          const radiusScale = d3.scaleSqrt()
            .domain([0, d3.max(stations, d => d.totalTraffic)])
            .range([0, 25]);
          return radiusScale(d.totalTraffic);
        })
        // Set an initial fill (it will be overridden by CSS via the custom property)
        .attr('fill', 'steelblue')
        .attr('stroke', 'white')
        .attr('stroke-width', 1)
        .attr('opacity', 0.6)
        .style('pointer-events', 'auto')
        // Set the custom property for departure ratio.
        .style("--departure-ratio", d =>
          d.totalTraffic ? stationFlow(d.departures / d.totalTraffic) : 0)
        .each(function(d) {
          d3.select(this)
            .append('title')
            .text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
        });

      // Function to update circle positions as the map moves.
      function updatePositions() {
        circles
          .attr('cx', d => {
            const point = new mapboxgl.LngLat(+d.lon, +d.lat);
            return map.project(point).x;
          })
          .attr('cy', d => {
            const point = new mapboxgl.LngLat(+d.lon, +d.lat);
            return map.project(point).y;
          });
      }
      updatePositions();
      map.on('move', updatePositions);
      map.on('zoom', updatePositions);
      map.on('resize', updatePositions);
      map.on('moveend', updatePositions);

      // --- Define Filtering Functionality ---
      // Following the instructions, we create new data structures for filteredTrips, filteredDepartures,
      // filteredArrivals, and filteredStations.
      filterTripsByTime = function() {
        // 1. Create filteredTrips: if no filtering, use all trips; otherwise, filter trips.
        let filteredTrips = timeFilter === -1
          ? trips
          : trips.filter(trip => {
              const startedMinutes = minutesSinceMidnight(trip.started_at);
              const endedMinutes = minutesSinceMidnight(trip.ended_at);
              return (
                Math.abs(startedMinutes - timeFilter) <= 60 ||
                Math.abs(endedMinutes - timeFilter) <= 60
              );
            });

        // 2. Create filteredDepartures and filteredArrivals via d3.rollup on filteredTrips.
        let filteredDepartures = d3.rollup(
          filteredTrips,
          v => v.length,
          d => d.start_station_id
        );
        let filteredArrivals = d3.rollup(
          filteredTrips,
          v => v.length,
          d => d.end_station_id
        );

        // 3. Create filteredStations by cloning each station and updating its traffic.
        filteredStations = stations.map(station => {
          let st = { ...station }; // clone to avoid modifying original
          let id = st.short_name;
          st.departures = filteredDepartures.get(id) ?? 0;
          st.arrivals = filteredArrivals.get(id) ?? 0;
          st.totalTraffic = st.departures + st.arrivals;
          return st;
        });

        // 4. Create a conditional radius scale:
        //    - If no filtering, use range [0, 25]; otherwise, use range [3, 50]
        const radiusScale = d3.scaleSqrt()
          .domain([
            0,
            timeFilter === -1
              ? d3.max(stations, d => d.totalTraffic)
              : d3.max(filteredStations, d => d.totalTraffic)
          ])
          .range(timeFilter === -1 ? [0, 25] : [3, 50]);

        // 5. Update the circles with the filtered station data.
        circles
          .data(filteredStations)
          .transition()
          .duration(200)
          .attr('r', d => radiusScale(d.totalTraffic))
          .each(function(d) {
            d3.select(this)
              .select('title')
              .text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
          })
          // Update the custom property for departure ratio.
          .style("--departure-ratio", d =>
            d.totalTraffic ? stationFlow(d.departures / d.totalTraffic) : 0);
      };

      // Run filtering initially.
      filterTripsByTime();
    })
    .catch(error => {
      console.error('Error loading station or traffic data:', error);
    });
});
