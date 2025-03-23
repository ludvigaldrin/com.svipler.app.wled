'use strict';

const Homey = require('homey');

class WLEDApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('WLED Controller app is running...');
    
    // Register Flow Cards
    this.registerFlowCards();
  }
  
  registerFlowCards() {
    // Action flow card for setting effects
    this.homey.flow.getActionCard('set_effect')
      .registerRunListener(async (args, state) => {
        const { device, effect } = args;
        return device.setEffect(effect.id);
      })
      .getArgument('effect')
      .registerAutocompleteListener(async (query, args) => {
        const { device } = args;
        return device.getEffectsList(query);
      });
      
    // Action flow card for setting palettes
    this.homey.flow.getActionCard('set_palette')
      .registerRunListener(async (args, state) => {
        const { device, palette } = args;
        return device.setPalette(palette.id);
      })
      .getArgument('palette')
      .registerAutocompleteListener(async (query, args) => {
        const { device } = args;
        return device.getPalettesList(query);
      });
      
    // Action flow card for setting a playlist
    this.homey.flow.getActionCard('start_playlist')
      .registerRunListener(async (args, state) => {
        const { device, presets, durations, repeat } = args;
        return device.startPlaylist(presets, durations, repeat);
      });
  }
}

module.exports = WLEDApp;
