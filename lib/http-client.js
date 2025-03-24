'use strict';

const axios = require('axios');

class HttpClient {
  constructor(options = {}) {
    this.client = axios.create({
      baseURL: options.baseURL || '',
      timeout: options.timeout || 5000,
      headers: options.headers || {}
    });
  }

  async get(path, params) {
    try {
      const response = await this.client.get(path, { params });
      return response.data;
    } catch (error) {
      throw new Error(`GET request failed: ${error.message}`);
    }
  }

  async post(path, data) {
    try {
      const response = await this.client.post(path, data);
      return response.data;
    } catch (error) {
      throw new Error(`POST request failed: ${error.message}`);
    }
  }
}

module.exports = {
  HttpClient
}; 