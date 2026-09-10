# Home Assistant dashboard dead-entity audit

- **Kanban:** #237
- **Audit időpontja:** 2026-09-04T21:05:08.883693+02:00
- **Dashboard:** Overview (`lovelace`, storage mode)
- **Nézetek:** 11
- **Élő HA entitások:** 1314
- **Egyedi dashboard-entitás hivatkozások:** 313

## Összefoglaló

- Biztosan hiányzó entitások: **16**
- `unavailable` entitások: **24**
- Nem-button `unknown` entitások: **7**
- Button `unknown` (nem tekinthető automatikusan hibának): **17**
- Szolgáltatáshívásként felismert, nem entitás: **1**

A `missing` azt jelenti, hogy a dashboard hivatkozik az entity_id-ra, de az nincs benne a Home Assistant aktuális state registry válaszában. Az `unavailable` entitás létezik, de az integráció/eszköz nem szolgáltat állapotot. A button entitások `unknown` állapota gyakran normális, ezért ezeket külön kezeljük.

## Biztosan hiányzó dashboard-entitások

| Entity | Név | Hivatkozások | Első hely |
|---|---|---:|---|
| `binary_sensor.furdo_ablak_contact` | — | 1 | `$.views[4].cards[28].entities[0].entity` |
| `binary_sensor.sensor_contact` | — | 1 | `$.views[4].cards[29].entities[0].entity` |
| `button.dirigera_identify` | — | 2 | `$.views[9].sections[8].cards[1].secondary` |
| `light.kajplats_gu10_cws_575lm` | — | 2 | `$.views[4].badges[3].entity` |
| `script.led_fade_10_steps_to_orange` | — | 1 | `$.views[5].cards[0].footer.entities[1].entity` |
| `script.led_start_now` | — | 2 | `$.views[5].cards[0].entities[4].entity` |
| `sensor.bthome_sensor_a77e_humidity` | — | 2 | `$.views[4].cards[10].entities[0].entity` |
| `sensor.bthome_sensor_a77e_signal_strength` | — | 1 | `$.views[9].sections[9].cards[4].entities[1].entity` |
| `sensor.bthome_sensor_a77e_temperature` | — | 1 | `$.views[4].cards[25].entity` |
| `sensor.nappali_nappali2` | — | 1 | `$.views[0].sections[4].cards[4].entity` |
| `switch.dome_ideglenes_elkerulese` | — | 1 | `$.views[8].sections[2].cards[4].entity` |
| `switch.dome_locsolt` | — | 1 | `$.views[8].sections[2].cards[5].entity` |
| `switch.dome_medi_elkerulese` | — | 1 | `$.views[8].sections[2].cards[6].entity` |
| `switch.dome_tolto_elkerulese` | — | 1 | `$.views[8].sections[2].cards[8].entity` |
| `switch.outlet` | — | 1 | `$.views[4].cards[34].entity` |
| `switch.tretakt_smart_plug` | — | 2 | `$.views[0].sections[3].cards[6].entity` |

## Elérhetetlen entitások

| Entity | Név | Hivatkozások | Első hely |
|---|---|---:|---|
| `button.dome_hiba_megerositese` | Döme Hiba megerősítése | 1 | `$.views[8].sections[2].cards[3].entity` |
| `button.dome_ora_szinkronizalasa` | Döme Óra szinkronizálása | 1 | `$.views[8].sections[2].cards[7].entity` |
| `button.dome_vagokes_hasznalati_ido_visszaallitasa` | Döme Vágókés használati idő visszaállítása | 1 | `$.views[8].sections[2].cards[10].entity` |
| `button.mosi_pause` | Mosi Pause | 1 | `$.views[4].cards[22].entities[1]` |
| `button.mosi_remote_start` | Mosi Remote Start | 1 | `$.views[4].cards[22].entities[3]` |
| `button.obo_base_station_cleaning` | Obo Base Station Cleaning | 1 | `$.views[7].sections[1].cards[42].entity` |
| `button.obo_base_station_self_repair` | Obo Base Station Self Repair | 1 | `$.views[7].sections[1].cards[41].entity` |
| `button.szari_pause` | Szári Pause | 1 | `$.views[4].cards[23].entities[1]` |
| `button.szari_remote_start` | Szári Remote Start | 1 | `$.views[4].cards[23].entities[3]` |
| `media_player.chromecast2534` | Master Bedroom | 2 | `$.views[0].sections[8].cards[2].entity` |
| `media_player.master_bedroom_speaker` | Master Bedroom speaker | 1 | `$.views[0].sections[8].cards[3].entity` |
| `select.mosi_course_selection` | Mosi Course selection | 1 | `$.views[4].cards[22].entities[0]` |
| `select.obo_cleaning_mode` | Obo Cleaning Mode | 2 | `$.views[0].sections[7].cards[2].secondary` |
| `select.obo_self_clean_frequency` | Obo Self Clean Frequency | 1 | `$.views[7].sections[1].cards[16].entity` |
| `select.szari_course_selection` | Szári Course selection | 1 | `$.views[4].cards[23].entities[0]` |
| `sensor.dome_hatralevo_toltesi_ido` | Döme Hátralévő töltési idő | 1 | `$.views[8].sections[1].cards[4].entity` |
| `sensor.ebusd_boiler_ebusd_boiler_boiler_lwt_temp` | ebusd boiler ebusd boiler boiler_LWT_temp  | 1 | `$.views[4].cards[2].entities[0].entity` |
| `sensor.ebusd_boiler_ebusd_boiler_boiler_status_boilerstatus` | ebusd boiler ebusd boiler boiler_status boilerstatus | 1 | `$.views[4].cards[2].entities[3].entity` |
| `sensor.ebusd_boiler_ebusd_boiler_ewt_temp` | ebusd boiler ebusd boiler EWT_temp  | 1 | `$.views[4].cards[2].entities[1].entity` |
| `sensor.ebusd_boiler_ebusd_boiler_ext_temp` | ebusd boiler ebusd boiler ext_temp  | 1 | `$.views[4].cards[2].entities[2].entity` |
| `switch.dome_a_pazsitom` | Döme A pázsitom | 1 | `$.views[8].sections[2].cards[1].entity` |
| `switch.dome_utemezes_engedelyezese` | Döme Ütemezés engedélyezése | 1 | `$.views[8].sections[2].cards[9].entity` |
| `switch.mosi_power` | Mosi Power | 1 | `$.views[4].cards[22].entities[2]` |
| `switch.szari_power` | Szári Power | 1 | `$.views[4].cards[23].entities[2]` |

## Ismeretlen állapotú nem-button entitások

| Entity | Név | Hivatkozások | Első hely |
|---|---|---:|---|
| `sensor.ble_humidity_a4c13823e4dc` | A4C13823E4DC ble humidity A4C13823E4DC | 1 | `$.views[4].cards[11].entity` |
| `sensor.ble_humidity_a4c13829b407` | A4C13829B407 ble humidity A4C13829B407 | 1 | `$.views[4].cards[32].entity` |
| `sensor.ble_rssi_a4c13823e4dc` | A4C13823E4DC ble rssi A4C13823E4DC | 1 | `$.views[9].sections[9].cards[4].entities[0].entity` |
| `sensor.ble_rssi_a4c13829b407` | A4C13829B407 ble rssi A4C13829B407 | 1 | `$.views[9].sections[9].cards[4].entities[2].entity` |
| `sensor.ble_temperature_a4c13823e4dc` | A4C13823E4DC ble temperature A4C13823E4DC | 1 | `$.views[4].cards[13].entity` |
| `sensor.ble_temperature_a4c13829b407` | A4C13829B407 ble temperature A4C13829B407 | 1 | `$.views[4].cards[12].entity` |
| `sensor.klipper_print_eta` | Klipper Print ETA | 1 | `$.views[6].sections[1].cards[21].entity` |

## Button entitások `unknown` állapottal

| Entity | Név | Hivatkozások | Első hely |
|---|---|---:|---|
| `button.klipper_cancel_print` | Klipper Cancel Print | 1 | `$.views[6].sections[0].cards[2].entity` |
| `button.klipper_emergency_stop` | Klipper Emergency Stop | 1 | `$.views[6].sections[0].cards[3].entity` |
| `button.klipper_home_all_axes` | Klipper Home All Axes | 1 | `$.views[6].sections[0].cards[6].entity` |
| `button.klipper_home_x_axis` | Klipper Home X Axis | 1 | `$.views[6].sections[0].cards[7].entity` |
| `button.klipper_home_y_axis` | Klipper Home Y Axis | 1 | `$.views[6].sections[0].cards[8].entity` |
| `button.klipper_home_z_axis` | Klipper Home Z Axis | 1 | `$.views[6].sections[0].cards[9].entity` |
| `button.klipper_pause_print` | Klipper Pause Print | 1 | `$.views[6].sections[0].cards[10].entity` |
| `button.klipper_resume_print` | Klipper Resume Print | 1 | `$.views[6].sections[0].cards[11].entity` |
| `button.obo_clear_warning` | Obo Clear Warning | 1 | `$.views[7].sections[1].cards[36].entity` |
| `button.obo_manual_drying` | Obo Stop Drying | 1 | `$.views[7].sections[1].cards[7].entity` |
| `button.obo_reset_filter` | Obo Reset Filter | 1 | `$.views[7].sections[0].cards[1].entity` |
| `button.obo_reset_main_brush` | Obo Reset Main Brush | 1 | `$.views[7].sections[0].cards[2].entity` |
| `button.obo_reset_sensor` | Obo Reset Sensor | 1 | `$.views[7].sections[0].cards[3].entity` |
| `button.obo_reset_side_brush` | Obo Reset Side Brush | 1 | `$.views[7].sections[0].cards[4].entity` |
| `button.obo_reset_wheel` | Obo Reset Wheel | 1 | `$.views[7].sections[0].cards[5].entity` |
| `button.obo_self_clean` | Obo Self-Clean | 1 | `$.views[7].sections[1].cards[14].entity` |
| `button.obo_start_auto_empty` | Obo Start Auto Empty | 1 | `$.views[7].sections[1].cards[8].entity` |

## Kizárt szolgáltatáshivatkozások

| Entity | Név | Hivatkozások | Első hely |
|---|---|---:|---|
| `remote.send_command` | — | 10 | `$.views[0].sections[5].cards[3].cards[0].tap_action.perform_action` |

## Javasolt sorrend

1. A biztosan hiányzó entitásoknál döntés: új entity_id-ra csere vagy kártya eltávolítása. Elsőként: `light.kajplats_gu10_cws_575lm` és `switch.tretakt_smart_plug`, mert többször szerepelnek.
2. A Miele (`mosi`/`szari`) és Döme entitásokat integrációszinten kell helyreállítani; egyedi kártyatörlés előtt ellenőrizendő, hogy az eszközök még használatban vannak-e.
3. Az eBUS szenzorok elérhetetlensége külön, már létező Kanban-feladathoz kapcsolódik; ne javítsuk dashboard-szinten az integráció diagnózisa előtt.
4. A BLE szenzorok `unknown` állapota kapcsolat- vagy elemproblémára utalhat; trend és utolsó frissítés alapján vizsgálandó.
5. A button `unknown` tételeket ne töröljük automatikusan: a button domain állapota nem megbízható dead-entity jelző.

## Biztonság és hatókör

- Az audit kizárólag olvasási műveleteket végzett.
- Lovelace-konfiguráció, entitás és integráció nem lett módosítva.
- Automatikus törlés nem javasolt; minden hiányzó entitásnál felhasználói szándékot kell ellenőrizni.

## Reprodukció

- Dashboard-forrás: Home Assistant WebSocket `lovelace/config`.
- Állapotforrás: Home Assistant REST `/api/states`.
- Összevetés: az Overview konfigurációban talált egyedi entity_id-k és az élő state registry halmaza.