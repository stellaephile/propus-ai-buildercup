Data Attribution & Licenses
This project uses exclusively open, publicly licensed datasets. All sources are listed below
with their respective licenses and attribution requirements.

1. Delhi Bus Network (GTFS Static)
Provider: Open Transit Data (OTD), Government of Delhi
URL: https://otd.delhi.gov.in/data/static/
License: Open Government Data (OGD) Platform India License
Attribution: © Open Transit Data, Government of Delhi
Usage: Bus stops, routes, trips, stop times

2. Delhi Metro (GTFS Static)
Provider: Delhi Metro Rail Corporation (DMRC) via OTD
URL: https://otd.delhi.gov.in/data/staticDMRC/
License: Open Government Data (OGD) Platform India License
Attribution: © Delhi Metro Rail Corporation (DMRC)
Usage: Metro stations, lines, interchange information

3. OpenStreetMap (Roads, Footpaths, POIs, Land Use)
Provider: OpenStreetMap Contributors via Geofabrik
URL: https://download.geofabrik.de/asia/india.html
License: Open Database License (ODbL) v1.0
Attribution: © OpenStreetMap contributors
License URL: https://www.openstreetmap.org/copyright
Usage: Road network, footpaths, bus stops, buildings, land use polygons for Delhi/NCR

4. Delhi Ward Boundaries
Provider: OpenCity
URL: https://data.opencity.in/dataset/delhi-wards-information
License: Open Data Commons Attribution License (ODC-By)
Attribution: © OpenCity (data.opencity.in)
Usage: Ward boundary polygons for spatial joins and aggregation.
Contents as loaded (checked 2026-10-18): 290 polygons = 272 numbered MCD wards, 9 NDMC charge areas,
8 Cantonment charge areas and 1 other. The 272 numbered wards are the delimitation before 2022
(the 2022 delimitation has 250 wards), so ward names and boundaries may not match the current ones.

5. Delhi Ward Boundaries (Alternate / Backup)
Provider: DataMeet India
URL: https://github.com/datameet/Municipal_Spatial_Data/tree/master/Delhi
License: Creative Commons Attribution-ShareAlike 2.5 India (CC BY-SA 2.5 IN)
Attribution: © DataMeet India Community
Usage: Municipal spatial data for Delhi wards (backup source)

6. India Administrative Boundaries (Districts, Sub-districts)
Provider: datta07 / INDIAN-SHAPEFILES (GitHub)
URL: https://github.com/datta07/INDIAN-SHAPEFILES
License: Public / Open (GitHub repository)
Attribution: © datta07, INDIAN-SHAPEFILES contributors
Coordinate System: WGS84 (EPSG:4326)
Usage: Delhi district and sub-district boundaries for spatial context
7. Map Marker Icons (bus / metro glyphs)
Provider: Maki Icons, Mapbox
URL: https://github.com/mapbox/maki
License: CC0 1.0 (public domain — no attribution required; listed for completeness)
Usage: bus and rail-metro glyphs in apps/web/public/icons/, tinted with design tokens at runtime
Note: The Delhi Metro (DMRC) logo is a registered trademark and is deliberately NOT used.

8. Population (WorldPop)
Provider: WorldPop, University of Southampton
URL: https://hub.worldpop.org/geodata/summary?id=49705
Dataset: India 2020, constrained individual countries, 100 m
License: Creative Commons Attribution 4.0 International (CC BY 4.0)
Attribution: © WorldPop (www.worldpop.org)
Usage: Population per 100 m cell for ward population and the coverage_gap tool

9. Sentinel-2 Surface Reflectance
Provider: European Space Agency (ESA), Copernicus Programme, via Google Earth Engine
Dataset: COPERNICUS/S2_SR_HARMONIZED
License: Copernicus Sentinel data legal notice (free, full and open access)
Attribution: Contains modified Copernicus Sentinel data [year]
Usage: Vegetation and built-up indices aggregated to wards

10. Landsat 8/9 Land Surface Temperature
Provider: U.S. Geological Survey (USGS), via Google Earth Engine
Dataset: LANDSAT/LC08/C02/T1_L2 and LANDSAT/LC09/C02/T1_L2 (Collection 2, Level 2, band ST_B10)
License: Public domain (U.S. Government work)
Attribution: Landsat-8/9 imagery courtesy of the U.S. Geological Survey
Usage: Summer (April to June) median land surface temperature around stops for the
stop_heat_exposure tool. Land surface temperature is a relative indicator, not air temperature.

Processing platform: Google Earth Engine (subject to the Earth Engine Terms of Service).

License Summary Table
Dataset License Commercial Use Attribution Required
Delhi Bus GTFS OGD India Yes Yes
Delhi Metro GTFS OGD India Yes Yes
OpenStreetMap ODbL v1.0 Yes Yes
Delhi Wards (OpenCity) ODC-By Yes Yes
Delhi Wards (DataMeet) CC BY-SA 2.5 IN Yes Yes (ShareAlike)
India Admin Boundaries Public/Open Yes Yes
WorldPop CC BY 4.0 Yes Yes
Sentinel-2 (Copernicus) Copernicus open access Yes Yes
Landsat 8/9 (USGS) Public domain Yes Requested
How Attribution is Applied in This Project
All map visualizations display “© OpenStreetMap contributors” in the map footer
The application README links to this file
No dataset has been modified in ways that misrepresent the original source
All data is used for non-commercial, research and demonstration purposes