'use strict';
/*
 * Kjøreverkets navn, for eksempel kv_52. Det står på én linje i /etc/kjoreverk/vehicle, som skrives
 * én gang når Pi-en settes opp, og leses bare.
 *
 *   tcplink-adapter.js og binary-adapter.js   navnet adapteren har i huben: kilden i alarmlisten og
 *                                             hendelsesloggen (taggene beholder prefikset, "pls")
 *   hub.js                                    kilden for alarmene og hendelsene fra beregningene
 *   recorder.js                               kjøreverkets id på den sentrale serveren
 *
 * Uten filen gir vehicleName() '', og hver av dem bruker sin egen reserve. HMI_VEHICLE_FILE
 * peker et annet sted, for tester. Kjører på Node 10 og nyere.
 */
const fs = require('fs');

const VEHICLE_FILE = process.env.HMI_VEHICLE_FILE || '/etc/kjoreverk/vehicle';
const VEHICLE_RX = /^[A-Za-z_][\w.-]{0,31}$/;

function vehicleName() {
  let text;
  try { text = fs.readFileSync(VEHICLE_FILE, 'utf8').trim(); } catch (e) { return ''; }
  if (!text) return '';
  if (!VEHICLE_RX.test(text)) {
    console.error(`${VEHICLE_FILE}: "${text.slice(0, 40)}" can't be used as a name (a letter first, then letters, digits, _ . -; at most 32 characters), ignored`);
    return '';
  }
  return text;
}

module.exports = { vehicleName, VEHICLE_FILE, VEHICLE_RX };
