/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React from 'react';
import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { ThemeBlueprint } from '@backstage/plugin-app-react';
import LightIcon from '@mui/icons-material/WbSunny';
import DarkIcon from '@mui/icons-material/Brightness2';
import { lightThemeProvider, darkThemeProvider } from './theme/providers';

export { LightIcon, DarkIcon, lightThemeProvider, darkThemeProvider };

export default createFrontendModule({
  pluginId: 'app',
  extensions: [
    ThemeBlueprint.make({
      name: 'qe-light',
      params: {
        theme: {
          id: 'rhdh-plugins-theme-qe-light',
          title: 'RHDH Plugins QE Light',
          variant: 'light',
          icon: React.createElement(LightIcon),
          Provider: lightThemeProvider,
        },
      },
    }),
    ThemeBlueprint.make({
      name: 'qe-dark',
      params: {
        theme: {
          id: 'rhdh-plugins-theme-qe-dark',
          title: 'RHDH Plugins QE Dark',
          variant: 'dark',
          icon: React.createElement(DarkIcon),
          Provider: darkThemeProvider,
        },
      },
    }),
  ],
});
