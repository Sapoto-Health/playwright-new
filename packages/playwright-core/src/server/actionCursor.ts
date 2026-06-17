/**
 * Copyright (c) Microsoft Corporation.
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

import { debugLogger } from '@utils/debugLogger';
import { Page } from './page';

import type { InputActionMode, InstrumentationListener, SdkObject } from './instrumentation';
import type * as types from './types';

export type ActionCursorOptions = {
  duration?: number,
  clickEffect?: 'none' | 'point',
};

export class ActionCursor implements InstrumentationListener {
  readonly page: Page;
  private _options: ActionCursorOptions | undefined;

  constructor(page: Page) {
    this.page = page;
    this.page.instrumentation.addListener(this, this.page.browserContext);
  }

  dispose() {
    this.page.instrumentation.removeListener(this);
  }

  show(options: ActionCursorOptions = {}) {
    if (this.page.browserContext._browser.options.name !== 'chromium')
      return;
    this._options = options;
  }

  async hide() {
    this._options = undefined;
    await this.hideInPage();
  }

  async hideInPage() {
    const page = this.page;
    if (page.isClosed())
      return;
    const utility = await page.mainFrame().utilityContext().catch(() => null);
    if (!utility)
      return;
    await utility.evaluate(async options => {
      const { injected } = options;
      injected.setActionCursor(null);
    }, {
      injected: await utility.injectedScript(),
    }).catch(e => debugLogger.log('error', e));
  }

  async onBeforeInputAction(sdkObject: SdkObject, _metadata: unknown, point?: types.Point, _box?: types.Rect, mode: InputActionMode = 'pointer'): Promise<void> {
    if (!this._options || !point)
      return;

    const page = sdkObject.attribution.page;
    if (page !== this.page)
      return;

    const utility = await page.mainFrame().utilityContext();
    const moveDuration = await utility.evaluate(async options => {
      const { injected } = options;
      return injected.setActionCursor(options);
    }, {
      injected: await utility.injectedScript(),
      duration: this._options.duration,
      clickEffect: this._options.clickEffect ?? 'point',
      point,
      mode,
    }).catch(e => debugLogger.log('error', e));
    if (typeof moveDuration === 'number' && moveDuration > 0)
      await new Promise(f => setTimeout(f, moveDuration));
  }
}
