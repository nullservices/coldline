import campus from './campus.js';
import shopfront from './shopfront.js';
import store from './store.js';
import invasion from './invasion.js';
import hacienda from './hacienda.js';
import rooftops from './rooftops.js';
import switchyard from './switchyard.js';

export const MAPS = [campus, shopfront, store, invasion, hacienda, rooftops, switchyard];
export const mapById = (id) => MAPS.find((m) => m.id === id) || MAPS[0];
