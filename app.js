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

    // Action flow card for setting presets
    this.homey.flow.getActionCard('set_preset')
      .registerRunListener(async (args, state) => {
        const { device, preset } = args;
        this.log(`Flow card: Setting preset ${preset.id} on device ${device.getName()}`);
        try {
          const result = await device.setPreset(preset.id);
          this.log(`Flow card: Preset ${preset.id} set successfully`);
          return result;
        } catch (error) {
          this.error(`Flow card: Failed to set preset ${preset.id}:`, error.message);
          throw error;
        }
      })
      .getArgument('preset')
      .registerAutocompleteListener(async (query, args) => {
        const { device } = args;
        try {
          const presets = await device.getPresetsList(query);
          this.log(`Flow card autocomplete: Found ${presets.length} presets for query "${query}"`);
          return presets;
        } catch (error) {
          this.error(`Flow card autocomplete: Error getting presets:`, error.message);
          return [];
        }
      });
  }
}

module.exports = WLEDApp;
