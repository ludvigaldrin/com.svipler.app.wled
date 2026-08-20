'use strict';

const Homey = require('homey');

class WLEDApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('WLED Controller app is running...');

    this.registerActionCards();
    this.registerConditionCards();
  }

  // Wire an autocomplete argument up to a device method
  _registerAutocomplete(card, argument, method) {
    card.getArgument(argument).registerAutocompleteListener(async (query, args) => {
      const { device } = args;

      if (!device) {
        return [];
      }

      try {
        return await device[method](query);
      } catch (error) {
        this.error(`Autocomplete for "${argument}" failed:`, error.message);
        return [];
      }
    });
  }

  registerActionCards() {
    // --- Whole device --------------------------------------------------------
    const setEffect = this.homey.flow.getActionCard('set_effect');
    setEffect.registerRunListener(async ({ device, effect }) => device.setEffect(effect.id));
    this._registerAutocomplete(setEffect, 'effect', 'getEffectsList');

    const setPalette = this.homey.flow.getActionCard('set_palette');
    setPalette.registerRunListener(async ({ device, palette }) => device.setPalette(palette.id));
    this._registerAutocomplete(setPalette, 'palette', 'getPalettesList');

    const setPreset = this.homey.flow.getActionCard('set_preset');
    setPreset.registerRunListener(async ({ device, preset }) => device.setPreset(preset.id));
    this._registerAutocomplete(setPreset, 'preset', 'getPresetsList');

    // --- Preset cycling ------------------------------------------------------
    this.homey.flow.getActionCard('next_preset')
      .registerRunListener(async ({ device }) => {
        const preset = await device.cyclePreset(1);
        return { preset: preset.name, preset_id: parseInt(preset.id, 10) };
      });

    this.homey.flow.getActionCard('previous_preset')
      .registerRunListener(async ({ device }) => {
        const preset = await device.cyclePreset(-1);
        return { preset: preset.name, preset_id: parseInt(preset.id, 10) };
      });

    // --- Individual segments -------------------------------------------------
    const segmentEffect = this.homey.flow.getActionCard('set_segment_effect');
    segmentEffect.registerRunListener(async ({ device, segment, effect }) => device.setSegmentEffect(segment.id, effect.id));
    this._registerAutocomplete(segmentEffect, 'segment', 'getSegmentsList');
    this._registerAutocomplete(segmentEffect, 'effect', 'getEffectsList');

    const segmentPalette = this.homey.flow.getActionCard('set_segment_palette');
    segmentPalette.registerRunListener(async ({ device, segment, palette }) => device.setSegmentPalette(segment.id, palette.id));
    this._registerAutocomplete(segmentPalette, 'segment', 'getSegmentsList');
    this._registerAutocomplete(segmentPalette, 'palette', 'getPalettesList');

    const segmentColor = this.homey.flow.getActionCard('set_segment_color');
    segmentColor.registerRunListener(async ({ device, segment, color }) => device.setSegmentColor(segment.id, color));
    this._registerAutocomplete(segmentColor, 'segment', 'getSegmentsList');

    const segmentBrightness = this.homey.flow.getActionCard('set_segment_brightness');
    segmentBrightness.registerRunListener(async ({ device, segment, brightness }) => device.setSegmentBrightness(segment.id, brightness));
    this._registerAutocomplete(segmentBrightness, 'segment', 'getSegmentsList');

    const segmentPower = this.homey.flow.getActionCard('set_segment_power');
    segmentPower.registerRunListener(async ({ device, segment, state }) => device.setSegmentPower(segment.id, state === 'on'));
    this._registerAutocomplete(segmentPower, 'segment', 'getSegmentsList');
  }

  registerConditionCards() {
    const effectIs = this.homey.flow.getConditionCard('effect_is');
    effectIs.registerRunListener(async ({ device, effect }) => device.getCapabilityValue('wled_effect') === String(effect.id));
    this._registerAutocomplete(effectIs, 'effect', 'getEffectsList');

    const paletteIs = this.homey.flow.getConditionCard('palette_is');
    paletteIs.registerRunListener(async ({ device, palette }) => device.getCapabilityValue('wled_palette') === String(palette.id));
    this._registerAutocomplete(paletteIs, 'palette', 'getPalettesList');

    const presetIs = this.homey.flow.getConditionCard('preset_is');
    presetIs.registerRunListener(async ({ device, preset }) => device.getCapabilityValue('wled_preset') === String(preset.id));
    this._registerAutocomplete(presetIs, 'preset', 'getPresetsList');
  }
}

module.exports = WLEDApp;
