/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/gotoErrorWidget';
import * as nls from 'vs/nls';
import * as dom from 'vs/base/browser/dom';
import { IDisposable, dispose, DisposableStore } from 'vs/base/common/lifecycle';
import { IMarker, MarkerSeverity, IRelatedInformation } from 'vs/platform/markers/common/markers';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { registerColor, oneOf, textLinkForeground, editorErrorForeground, editorErrorBorder, editorWarningForeground, editorWarningBorder, editorInfoForeground, editorInfoBorder } from 'vs/platform/theme/common/colorRegistry';
import { IThemeService, ITheme, registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { Color } from 'vs/base/common/color';
import { ScrollableElement } from 'vs/base/browser/ui/scrollbar/scrollableElement';
import { ScrollbarVisibility } from 'vs/base/common/scrollable';
import { ScrollType } from 'vs/editor/common/editorCommon';
import { getBaseLabel, getPathLabel } from 'vs/base/common/labels';
import { isNonEmptyArray } from 'vs/base/common/arrays';
import { Event, Emitter } from 'vs/base/common/event';
import { PeekViewWidget } from 'vs/editor/contrib/referenceSearch/peekViewWidget';
import { basename } from 'vs/base/common/resources';
import { IAction } from 'vs/base/common/actions';
import { IActionBarOptions, ActionsOrientation } from 'vs/base/browser/ui/actionbar/actionbar';
import { peekViewTitleForeground, peekViewTitleInfoForeground } from 'vs/editor/contrib/referenceSearch/referencesWidget';
import { AccessibilitySupport } from 'vs/platform/accessibility/common/accessibility';
import { SeverityIcon } from 'vs/platform/severityIcon/common/severityIcon';

class MessageWidget {

	private _lines: number = 0;
	private _longestLineLength: number = 0;

	private readonly _editor: ICodeEditor;
	private readonly _messageBlock: HTMLDivElement;
	private readonly _relatedBlock: HTMLDivElement;
	private readonly _scrollable: ScrollableElement;
	private readonly _relatedDiagnostics = new WeakMap<HTMLElement, IRelatedInformation>();
	private readonly _disposables: IDisposable[] = [];

	constructor(parent: HTMLElement, editor: ICodeEditor, onRelatedInformation: (related: IRelatedInformation) => void) {
		this._editor = editor;

		const domNode = document.createElement('div');
		domNode.className = 'descriptioncontainer';
		domNode.setAttribute('aria-live', 'assertive');
		domNode.setAttribute('role', 'alert');

		this._messageBlock = document.createElement('div');
		dom.addClass(this._messageBlock, 'message');
		domNode.appendChild(this._messageBlock);

		this._relatedBlock = document.createElement('div');
		domNode.appendChild(this._relatedBlock);
		this._disposables.push(dom.addStandardDisposableListener(this._relatedBlock, 'click', event => {
			event.preventDefault();
			const related = this._relatedDiagnostics.get(event.target);
			if (related) {
				onRelatedInformation(related);
			}
		}));

		this._scrollable = new ScrollableElement(domNode, {
			horizontal: ScrollbarVisibility.Auto,
			vertical: ScrollbarVisibility.Auto,
			useShadows: false,
			horizontalScrollbarSize: 3,
			verticalScrollbarSize: 3
		});
		parent.appendChild(this._scrollable.getDomNode());
		this._disposables.push(this._scrollable.onScroll(e => {
			domNode.style.left = `-${e.scrollLeft}px`;
			domNode.style.top = `-${e.scrollTop}px`;
		}));
		this._disposables.push(this._scrollable);
	}

	dispose(): void {
		dispose(this._disposables);
	}

	update({ source, message, relatedInformation, code }: IMarker): void {

		const lines = message.split(/\r\n|\r|\n/g);
		this._lines = lines.length;
		this._longestLineLength = 0;
		for (const line of lines) {
			this._longestLineLength = Math.max(line.length, this._longestLineLength);
		}

		dom.clearNode(this._messageBlock);
		this._editor.applyFontInfo(this._messageBlock);
		let lastLineElement = this._messageBlock;
		for (const line of lines) {
			lastLineElement = document.createElement('div');
			lastLineElement.innerText = line;
			if (line === '') {
				lastLineElement.style.height = this._messageBlock.style.lineHeight;
			}
			this._messageBlock.appendChild(lastLineElement);
		}
		if (source || code) {
			const detailsElement = document.createElement('span');
			dom.addClass(detailsElement, 'details');
			lastLineElement.appendChild(detailsElement);
			if (source) {
				const sourceElement = document.createElement('span');
				sourceElement.innerText = source;
				dom.addClass(sourceElement, 'source');
				detailsElement.appendChild(sourceElement);
			}
			if (code) {
				const codeElement = document.createElement('span');
				codeElement.innerText = `(${code})`;
				dom.addClass(codeElement, 'code');
				detailsElement.appendChild(codeElement);
			}
		}

		dom.clearNode(this._relatedBlock);
		this._editor.applyFontInfo(this._relatedBlock);
		if (isNonEmptyArray(relatedInformation)) {
			const relatedInformationNode = this._relatedBlock.appendChild(document.createElement('div'));
			relatedInformationNode.style.paddingTop = `${Math.floor(this._editor.getConfiguration().lineHeight * 0.66)}px`;
			this._lines += 1;

			for (const related of relatedInformation) {

				let container = document.createElement('div');

				let relatedResource = document.createElement('a');
				dom.addClass(relatedResource, 'filename');
				relatedResource.innerHTML = `${getBaseLabel(related.resource)}(${related.startLineNumber}, ${related.startColumn}): `;
				relatedResource.title = getPathLabel(related.resource, undefined);
				this._relatedDiagnostics.set(relatedResource, related);

				let relatedMessage = document.createElement('span');
				relatedMessage.innerText = related.message;

				container.appendChild(relatedResource);
				container.appendChild(relatedMessage);

				this._lines += 1;
				relatedInformationNode.appendChild(container);
			}
		}

		const fontInfo = this._editor.getConfiguration().fontInfo;
		const scrollWidth = Math.ceil(fontInfo.typicalFullwidthCharacterWidth * this._longestLineLength * 0.75);
		const scrollHeight = fontInfo.lineHeight * this._lines;
		this._scrollable.setScrollDimensions({ scrollWidth, scrollHeight });
	}

	layout(height: number, width: number): void {
		this._scrollable.getDomNode().style.height = `${height}px`;
		this._scrollable.getDomNode().style.width = `${width}px`;
		this._scrollable.setScrollDimensions({ width, height });
	}

	getHeightInLines(): number {
		return Math.min(17, this._lines);
	}
}

export class MarkerNavigationWidget extends PeekViewWidget {

	private _parentContainer: HTMLElement;
	private _container: HTMLElement;
	private _icon: HTMLElement;
	private _message: MessageWidget;
	private readonly _callOnDispose = new DisposableStore();
	private _severity: MarkerSeverity;
	private _backgroundColor?: Color;
	private _onDidSelectRelatedInformation = new Emitter<IRelatedInformation>();
	private _heightInPixel: number;

	readonly onDidSelectRelatedInformation: Event<IRelatedInformation> = this._onDidSelectRelatedInformation.event;

	constructor(
		editor: ICodeEditor,
		private readonly actions: IAction[],
		private readonly _themeService: IThemeService
	) {
		super(editor, { showArrow: true, showFrame: true, isAccessible: true });
		this._severity = MarkerSeverity.Warning;
		this._backgroundColor = Color.white;

		this._applyTheme(_themeService.getTheme());
		this._callOnDispose.add(_themeService.onThemeChange(this._applyTheme.bind(this)));

		this.create();
	}

	private _applyTheme(theme: ITheme) {
		this._backgroundColor = theme.getColor(editorMarkerNavigationBackground);
		let colorId = editorMarkerNavigationError;
		if (this._severity === MarkerSeverity.Warning) {
			colorId = editorMarkerNavigationWarning;
		} else if (this._severity === MarkerSeverity.Info) {
			colorId = editorMarkerNavigationInfo;
		}
		const frameColor = theme.getColor(colorId);
		this.style({
			arrowColor: frameColor,
			frameColor: frameColor,
			headerBackgroundColor: this._backgroundColor,
			primaryHeadingColor: theme.getColor(peekViewTitleForeground),
			secondaryHeadingColor: theme.getColor(peekViewTitleInfoForeground)
		}); // style() will trigger _applyStyles
	}

	protected _applyStyles(): void {
		if (this._parentContainer) {
			this._parentContainer.style.backgroundColor = this._backgroundColor ? this._backgroundColor.toString() : '';
		}
		super._applyStyles();
	}

	dispose(): void {
		this._callOnDispose.dispose();
		super.dispose();
	}

	focus(): void {
		this._parentContainer.focus();
	}

	protected _fillHead(container: HTMLElement): void {
		super._fillHead(container);
		this._actionbarWidget.push(this.actions, { label: false, icon: true });
	}

	protected _fillTitleIcon(container: HTMLElement): void {
		this._icon = dom.append(container, dom.$(''));
	}

	protected _getActionBarOptions(): IActionBarOptions {
		return {
			orientation: ActionsOrientation.HORIZONTAL_REVERSE
		};
	}

	protected _fillBody(container: HTMLElement): void {
		this._parentContainer = container;
		dom.addClass(container, 'marker-widget');
		this._parentContainer.tabIndex = 0;
		this._parentContainer.setAttribute('role', 'tooltip');

		this._container = document.createElement('div');
		container.appendChild(this._container);

		this._message = new MessageWidget(this._container, this.editor, related => this._onDidSelectRelatedInformation.fire(related));
		this._disposables.add(this._message);
	}

	show(where: Position, heightInLines: number): void {
		throw new Error('call showAtMarker');
	}

	showAtMarker(marker: IMarker, markerIdx: number, markerCount: number): void {
		// update:
		// * title
		// * message
		this._container.classList.remove('stale');
		this._message.update(marker);

		// update frame color (only applied on 'show')
		this._severity = marker.severity;
		this._applyTheme(this._themeService.getTheme());

		// show
		let range = Range.lift(marker);
		const editorPosition = this.editor.getPosition();
		let position = editorPosition && range.containsPosition(editorPosition) ? editorPosition : range.getStartPosition();
		super.show(position, this.computeRequiredHeight());

		const model = this.editor.getModel();
		if (model) {
			const detail = markerCount > 1
				? nls.localize('problems', "{0} of {1} problems", markerIdx, markerCount)
				: nls.localize('change', "{0} of {1} problem", markerIdx, markerCount);
			this.setTitle(basename(model.uri), detail);
		}
		this._icon.className = SeverityIcon.className(MarkerSeverity.toSeverity(this._severity));

		this.editor.revealPositionInCenter(position, ScrollType.Smooth);

		if (this.editor.getConfiguration().accessibilitySupport !== AccessibilitySupport.Disabled) {
			this.focus();
		}
	}

	updateMarker(marker: IMarker): void {
		this._container.classList.remove('stale');
		this._message.update(marker);
	}

	showStale() {
		this._container.classList.add('stale');
		this._relayout();
	}

	protected _doLayoutBody(heightInPixel: number, widthInPixel: number): void {
		super._doLayoutBody(heightInPixel, widthInPixel);
		this._heightInPixel = heightInPixel;
		this._message.layout(heightInPixel, widthInPixel);
		this._container.style.height = `${heightInPixel}px`;
	}

	public _onWidth(widthInPixel: number): void {
		this._message.layout(this._heightInPixel, widthInPixel);
	}

	protected _relayout(): void {
		super._relayout(this.computeRequiredHeight());
	}

	private computeRequiredHeight() {
		return 3 + this._message.getHeightInLines();
	}
}

// theming

let errorDefault = oneOf(editorErrorForeground, editorErrorBorder);
let warningDefault = oneOf(editorWarningForeground, editorWarningBorder);
let infoDefault = oneOf(editorInfoForeground, editorInfoBorder);

export const editorMarkerNavigationError = registerColor('editorMarkerNavigationError.background', { dark: errorDefault, light: errorDefault, hc: errorDefault }, nls.localize('editorMarkerNavigationError', 'Editor marker navigation widget error color.'));
export const editorMarkerNavigationWarning = registerColor('editorMarkerNavigationWarning.background', { dark: warningDefault, light: warningDefault, hc: warningDefault }, nls.localize('editorMarkerNavigationWarning', 'Editor marker navigation widget warning color.'));
export const editorMarkerNavigationInfo = registerColor('editorMarkerNavigationInfo.background', { dark: infoDefault, light: infoDefault, hc: infoDefault }, nls.localize('editorMarkerNavigationInfo', 'Editor marker navigation widget info color.'));
export const editorMarkerNavigationBackground = registerColor('editorMarkerNavigation.background', { dark: '#2D2D30', light: Color.white, hc: '#0C141F' }, nls.localize('editorMarkerNavigationBackground', 'Editor marker navigation widget background.'));

registerThemingParticipant((theme, collector) => {
	const link = theme.getColor(textLinkForeground);
	if (link) {
		collector.addRule(`.monaco-editor .marker-widget a { color: ${link}; }`);
	}
});
