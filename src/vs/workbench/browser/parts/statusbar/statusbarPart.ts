/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/statusbarpart';
import * as nls from 'vs/nls';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { dispose, IDisposable, Disposable, toDisposable } from 'vs/base/common/lifecycle';
import { OcticonLabel } from 'vs/base/browser/ui/octiconLabel/octiconLabel';
import { Registry } from 'vs/platform/registry/common/platform';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { Part } from 'vs/workbench/browser/part';
import { IStatusbarRegistry, Extensions } from 'vs/workbench/browser/parts/statusbar/statusbar';
import { IInstantiationService, ServiceIdentifier } from 'vs/platform/instantiation/common/instantiation';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { StatusbarAlignment, IStatusbarService, IStatusbarEntry, IStatusbarEntryAccessor } from 'vs/platform/statusbar/common/statusbar';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { Action, IAction } from 'vs/base/common/actions';
import { IThemeService, registerThemingParticipant, ITheme, ICssStyleCollector, ThemeColor } from 'vs/platform/theme/common/themeService';
import { STATUS_BAR_BACKGROUND, STATUS_BAR_FOREGROUND, STATUS_BAR_NO_FOLDER_BACKGROUND, STATUS_BAR_ITEM_HOVER_BACKGROUND, STATUS_BAR_ITEM_ACTIVE_BACKGROUND, STATUS_BAR_PROMINENT_ITEM_FOREGROUND, STATUS_BAR_PROMINENT_ITEM_BACKGROUND, STATUS_BAR_PROMINENT_ITEM_HOVER_BACKGROUND, STATUS_BAR_BORDER, STATUS_BAR_NO_FOLDER_FOREGROUND, STATUS_BAR_NO_FOLDER_BORDER } from 'vs/workbench/common/theme';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { contrastBorder } from 'vs/platform/theme/common/colorRegistry';
import { isThemeColor } from 'vs/editor/common/editorCommon';
import { Color } from 'vs/base/common/color';
import { addClass, EventHelper, createStyleSheet, addDisposableListener, addClasses, clearNode, removeClass, EventType, hide, show, removeClasses } from 'vs/base/browser/dom';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IStorageService, StorageScope, IWorkspaceStorageChangeEvent } from 'vs/platform/storage/common/storage';
import { Parts, IWorkbenchLayoutService } from 'vs/workbench/services/layout/browser/layoutService';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { coalesce } from 'vs/base/common/arrays';
import { StandardMouseEvent } from 'vs/base/browser/mouseEvent';
import { ToggleStatusbarVisibilityAction } from 'vs/workbench/browser/actions/layoutActions';
import { Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { values } from 'vs/base/common/map';

interface IPendingStatusbarEntry {
	id: string;
	name: string;
	entry: IStatusbarEntry;
	alignment: StatusbarAlignment;
	priority: number;
	accessor?: IStatusbarEntryAccessor;
}

interface IStatusbarViewModelEntry {
	id: string;
	name: string;
	alignment: StatusbarAlignment;
	priority: number;
	container: HTMLElement;
}

class StatusbarViewModel extends Disposable {

	private static readonly HIDDEN_ENTRIES_KEY = 'workbench.statusbar.hidden';

	private readonly _entries: IStatusbarViewModelEntry[] = [];
	get entries(): IStatusbarViewModelEntry[] { return this._entries; }

	private hidden: Set<string>;

	constructor(private storageService: IStorageService) {
		super();

		this.restoreState();
		this.registerListeners();
	}

	private restoreState(): void {
		const hiddenRaw = this.storageService.get(StatusbarViewModel.HIDDEN_ENTRIES_KEY, StorageScope.GLOBAL);
		if (hiddenRaw) {
			try {
				const hiddenArray: string[] = JSON.parse(hiddenRaw);
				this.hidden = new Set(hiddenArray);
			} catch (error) {
				// ignore parsing errors
			}
		}

		if (!this.hidden) {
			this.hidden = new Set<string>();
		}
	}

	private registerListeners(): void {
		this._register(this.storageService.onDidChangeStorage(e => this.onDidStorageChange(e)));
	}

	private onDidStorageChange(event: IWorkspaceStorageChangeEvent): void {
		if (event.key === StatusbarViewModel.HIDDEN_ENTRIES_KEY && event.scope === StorageScope.GLOBAL) {

			// Keep current hidden entries
			const currentlyHidden = new Set(this.hidden);

			// Load latest state of hidden entries
			this.hidden.clear();
			this.restoreState();

			const changed = new Set<string>();

			// Check for each entry that is now visible
			currentlyHidden.forEach(id => {
				if (!this.hidden.has(id)) {
					changed.add(id);
				}
			});

			// Check for each entry that is now hidden
			this.hidden.forEach(id => {
				if (!currentlyHidden.has(id)) {
					changed.add(id);
				}
			});

			// Update visibility for entries have changed
			if (changed.size > 0) {
				this._entries.forEach(entry => {
					if (changed.has(entry.id)) {
						this.updateVisibility(entry.id);

						changed.delete(entry.id);
					}
				});
			}
		}
	}

	add(entry: IStatusbarViewModelEntry): IDisposable {
		this._entries.push(entry); // intentionally not using a map here since multiple entries can have the same ID!

		// Update visibility directly
		this.updateVisibility(entry);

		// Sort according to priority
		this.sort();

		// Mark first/last visible entry
		this.markFirstLastVisibleEntry();

		return toDisposable(() => this.remove(entry));
	}

	private remove(entry: IStatusbarViewModelEntry): void {
		const index = this._entries.indexOf(entry);
		if (index >= 0) {
			this._entries.splice(index, 1);

			// Mark first/last visible entry
			this.markFirstLastVisibleEntry();
		}
	}

	isHidden(id: string): boolean {
		return this.hidden.has(id);
	}

	hide(id: string): void {
		if (!this.hidden.has(id)) {
			this.hidden.add(id);

			this.updateVisibility(id);

			this.saveState();
		}
	}

	show(id: string): void {
		if (this.hidden.has(id)) {
			this.hidden.delete(id);

			this.updateVisibility(id);

			this.saveState();
		}
	}

	findEntry(container: HTMLElement): IStatusbarViewModelEntry | undefined {
		for (const entry of this._entries) {
			if (entry.container === container) {
				return entry;
			}
		}

		return undefined;
	}

	getEntries(alignment: StatusbarAlignment): IStatusbarViewModelEntry[] {
		return this._entries.filter(entry => entry.alignment === alignment);
	}

	private updateVisibility(id: string): void;
	private updateVisibility(entry: IStatusbarViewModelEntry): void;
	private updateVisibility(arg1: string | IStatusbarViewModelEntry): void {

		// By identifier
		if (typeof arg1 === 'string') {
			const id = arg1;

			for (const entry of this._entries) {
				if (entry.id !== id) {
					continue;
				}

				this.updateVisibility(entry);
			}
		}

		// By entry
		else {
			const entry = arg1;
			const isHidden = this.isHidden(entry.id);

			// Use CSS to show/hide item container
			if (isHidden) {
				hide(entry.container);
			} else {
				show(entry.container);
			}

			// Mark first/last visible entry
			this.markFirstLastVisibleEntry();
		}
	}

	private saveState(): void {
		if (this.hidden.size > 0) {
			this.storageService.store(StatusbarViewModel.HIDDEN_ENTRIES_KEY, JSON.stringify(values(this.hidden)), StorageScope.GLOBAL);
		} else {
			this.storageService.remove(StatusbarViewModel.HIDDEN_ENTRIES_KEY, StorageScope.GLOBAL);
		}
	}

	private sort(): void {
		this._entries.sort((entryA, entryB) => {
			if (entryA.alignment === entryB.alignment) {
				return entryB.priority - entryA.priority; // higher priority towards the left
			}

			if (entryA.alignment === StatusbarAlignment.LEFT) {
				return -1;
			}

			if (entryB.alignment === StatusbarAlignment.LEFT) {
				return 1;
			}

			return 0;
		});
	}

	private markFirstLastVisibleEntry(): void {
		this.doMarkFirstLastVisibleStatusbarItem(this.getEntries(StatusbarAlignment.LEFT));
		this.doMarkFirstLastVisibleStatusbarItem(this.getEntries(StatusbarAlignment.RIGHT));
	}

	private doMarkFirstLastVisibleStatusbarItem(entries: IStatusbarViewModelEntry[]): void {
		let firstVisibleItem: IStatusbarViewModelEntry | undefined;
		let lastVisibleItem: IStatusbarViewModelEntry | undefined;

		for (const entry of entries) {

			// Clear previous first
			removeClasses(entry.container, 'first-visible-item', 'last-visible-item');

			const isVisible = !this.isHidden(entry.id);
			if (isVisible) {
				if (!firstVisibleItem) {
					firstVisibleItem = entry;
				}

				lastVisibleItem = entry;
			}
		}

		// Mark: first visible item
		if (firstVisibleItem) {
			addClass(firstVisibleItem.container, 'first-visible-item');
		}

		// Mark: last visible item
		if (lastVisibleItem) {
			addClass(lastVisibleItem.container, 'last-visible-item');
		}
	}
}

class ToggleStatusbarEntryVisibilityAction extends Action {

	constructor(id: string, label: string, private model: StatusbarViewModel) {
		super(id, label, undefined, true);

		this.checked = !model.isHidden(id);
	}

	run(): Promise<any> {
		if (this.model.isHidden(this.id)) {
			this.model.show(this.id);
		} else {
			this.model.hide(this.id);
		}

		return Promise.resolve(true);
	}
}

class HideStatusbarEntryAction extends Action {

	constructor(id: string, private model: StatusbarViewModel) {
		super(id, nls.localize('hide', "Hide"), undefined, true);
	}

	run(): Promise<any> {
		this.model.hide(this.id);

		return Promise.resolve(true);
	}
}

export class StatusbarPart extends Part implements IStatusbarService {

	_serviceBrand: ServiceIdentifier<IStatusbarService>;

	//#region IView

	readonly minimumWidth: number = 0;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	readonly minimumHeight: number = 22;
	readonly maximumHeight: number = 22;

	//#endregion

	private styleElement: HTMLStyleElement;

	private pendingEntries: IPendingStatusbarEntry[] = [];

	private readonly viewModel: StatusbarViewModel;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextMenuService private contextMenuService: IContextMenuService
	) {
		super(Parts.STATUSBAR_PART, { hasTitle: false }, themeService, storageService, layoutService);

		this.viewModel = this._register(new StatusbarViewModel(storageService));

		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.contextService.onDidChangeWorkbenchState(() => this.updateStyles()));
	}

	addEntry(entry: IStatusbarEntry, id: string, name: string, alignment: StatusbarAlignment, priority: number = 0): IStatusbarEntryAccessor {

		// As long as we have not been created into a container yet, record all entries
		// that are pending so that they can get created at a later point
		if (!this.element) {
			return this.doAddPendingEntry(entry, id, name, alignment, priority);
		}

		// Otherwise add to view
		return this.doAddEntry(entry, id, name, alignment, priority);
	}

	private doAddPendingEntry(entry: IStatusbarEntry, id: string, name: string, alignment: StatusbarAlignment, priority: number): IStatusbarEntryAccessor {
		const pendingEntry: IPendingStatusbarEntry = { entry, id, name, alignment, priority };
		this.pendingEntries.push(pendingEntry);

		const accessor: IStatusbarEntryAccessor = {
			update: (entry: IStatusbarEntry) => {
				if (pendingEntry.accessor) {
					pendingEntry.accessor.update(entry);
				} else {
					pendingEntry.entry = entry;
				}
			},

			dispose: () => {
				if (pendingEntry.accessor) {
					pendingEntry.accessor.dispose();
				} else {
					this.pendingEntries = this.pendingEntries.filter(entry => entry !== pendingEntry);
				}
			}
		};

		return accessor;
	}

	private doAddEntry(entry: IStatusbarEntry, id: string, name: string, alignment: StatusbarAlignment, priority: number): IStatusbarEntryAccessor {

		// Create item
		const itemContainer = this.doCreateStatusItem(id, name, alignment, priority, ...coalesce(['statusbar-entry', entry.showBeak ? 'has-beak' : undefined]));
		const item = this.instantiationService.createInstance(StatusbarEntryItem, itemContainer, entry);

		// Append to parent
		this.appendOneStatusbarEntry(itemContainer, alignment, priority);

		// Add to view model
		const viewModelEntry: IStatusbarViewModelEntry = { id, name, alignment, priority, container: itemContainer };
		const viewModelEntryDispose = this.viewModel.add(viewModelEntry);

		return {
			update: entry => {

				// Update beak
				if (entry.showBeak) {
					addClass(itemContainer, 'has-beak');
				} else {
					removeClass(itemContainer, 'has-beak');
				}

				// Update entry
				item.update(entry);
			},
			dispose: () => {
				dispose(viewModelEntryDispose);
				itemContainer.remove();
				dispose(item);
			}
		};
	}

	updateEntryVisibility(id: string, visible: boolean): void {
		if (visible) {
			this.viewModel.show(id);
		} else {
			this.viewModel.hide(id);
		}
	}

	createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;

		// Context menu support
		this._register(addDisposableListener(parent, EventType.CONTEXT_MENU, e => this.showContextMenu(e)));

		// Initial status bar entries
		this.createInitialStatusbarEntries();

		return this.element;
	}

	private createInitialStatusbarEntries(): void {
		const registry = Registry.as<IStatusbarRegistry>(Extensions.Statusbar);

		// Create initial items that were contributed from the registry
		for (const { id, name, alignment, priority, syncDescriptor } of registry.items) {

			// Create item
			const item = this.instantiationService.createInstance(syncDescriptor);
			const itemContainer = this.doCreateStatusItem(id, name, alignment, priority);
			this._register(item.render(itemContainer));

			// Add to view model
			const viewModelEntry: IStatusbarViewModelEntry = { id, name, alignment, priority, container: itemContainer };
			this.viewModel.add(viewModelEntry);
		}

		// Add items in order
		this.appendAllStatusbarEntries();

		// Fill in pending entries if any
		while (this.pendingEntries.length) {
			const pending = this.pendingEntries.shift();
			if (pending) {
				pending.accessor = this.addEntry(pending.entry, pending.id, pending.name, pending.alignment, pending.priority);
			}
		}
	}

	private appendAllStatusbarEntries(): void {

		// Append in order of priority
		[
			...this.viewModel.getEntries(StatusbarAlignment.LEFT),
			...this.viewModel.getEntries(StatusbarAlignment.RIGHT).reverse() // reversing due to display: float
		].forEach(entry => this.element.appendChild(entry.container));
	}

	private appendOneStatusbarEntry(itemContainer: HTMLElement, alignment: StatusbarAlignment, priority: number): void {
		const entries = this.viewModel.getEntries(alignment);

		if (alignment === StatusbarAlignment.RIGHT) {
			entries.reverse(); // reversing due to display: float
		}

		// find an entry that has lower priority than the new one
		// and then insert the item before that one
		let appended = false;
		for (const entry of entries) {
			if (
				alignment === StatusbarAlignment.LEFT && entry.priority < priority ||
				alignment === StatusbarAlignment.RIGHT && entry.priority > priority
			) {
				this.element.insertBefore(itemContainer, entry.container);
				appended = true;
				break;
			}
		}

		// Fallback to just appending otherwise
		if (!appended) {
			this.element.appendChild(itemContainer);
		}
	}

	private showContextMenu(e: MouseEvent): void {
		EventHelper.stop(e, true);

		const event = new StandardMouseEvent(e);

		let actions: IAction[] | undefined = undefined;
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: event.posx, y: event.posy }),
			getActions: () => {
				actions = this.getContextMenuActions(event);

				return actions;
			},
			onHide: () => {
				if (actions) {
					dispose(actions);
				}
			}
		});
	}

	private getContextMenuActions(event: StandardMouseEvent): IAction[] {
		const actions: Action[] = [];

		// Figure out if mouse is over an entry
		let statusEntryUnderMouse: IStatusbarViewModelEntry | undefined = undefined;
		for (let element: HTMLElement | null = event.target; element; element = element.parentElement) {
			const entry = this.viewModel.findEntry(element);
			if (entry) {
				statusEntryUnderMouse = entry;
				break;
			}
		}

		if (statusEntryUnderMouse) {
			actions.push(new HideStatusbarEntryAction(statusEntryUnderMouse.id, this.viewModel));
			actions.push(new Separator());
		}

		// Show an entry per known status entry
		// Note: even though entries have an identifier, there can be multiple entries
		// having the same identifier (e.g. from extensions). So we make sure to only
		// show a single entry per identifier we handled.
		const handledEntries = new Set<string>();
		this.viewModel.entries.forEach(entry => {
			if (!handledEntries.has(entry.id)) {
				actions.push(new ToggleStatusbarEntryVisibilityAction(entry.id, entry.name, this.viewModel));
			}
		});

		// Provide an action to hide the status bar at last
		actions.push(new Separator());
		actions.push(this.instantiationService.createInstance(ToggleStatusbarVisibilityAction, ToggleStatusbarVisibilityAction.ID, nls.localize('hideStatusBar', "Hide Status Bar")));

		return actions;
	}

	updateStyles(): void {
		super.updateStyles();

		const container = this.getContainer();

		// Background colors
		const backgroundColor = this.getColor(this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? STATUS_BAR_BACKGROUND : STATUS_BAR_NO_FOLDER_BACKGROUND);
		container.style.backgroundColor = backgroundColor;
		container.style.color = this.getColor(this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? STATUS_BAR_FOREGROUND : STATUS_BAR_NO_FOLDER_FOREGROUND);

		// Border color
		const borderColor = this.getColor(this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? STATUS_BAR_BORDER : STATUS_BAR_NO_FOLDER_BORDER) || this.getColor(contrastBorder);
		container.style.borderTopWidth = borderColor ? '1px' : null;
		container.style.borderTopStyle = borderColor ? 'solid' : null;
		container.style.borderTopColor = borderColor;

		// Notification Beak
		if (!this.styleElement) {
			this.styleElement = createStyleSheet(container);
		}

		this.styleElement.innerHTML = `.monaco-workbench .part.statusbar > .statusbar-item.has-beak:before { border-bottom-color: ${backgroundColor}; }`;
	}

	private doCreateStatusItem(id: string, name: string, alignment: StatusbarAlignment, priority: number = 0, ...extraClasses: string[]): HTMLElement {
		const itemContainer = document.createElement('div');
		itemContainer.title = name;

		addClass(itemContainer, 'statusbar-item');
		if (extraClasses) {
			addClasses(itemContainer, ...extraClasses);
		}

		if (alignment === StatusbarAlignment.RIGHT) {
			addClass(itemContainer, 'right');
		} else {
			addClass(itemContainer, 'left');
		}

		return itemContainer;
	}

	layout(width: number, height: number): void {
		super.layoutContents(width, height);
	}

	toJSON(): object {
		return {
			type: Parts.STATUSBAR_PART
		};
	}
}

class StatusbarEntryItem extends Disposable {
	private entryDisposables: IDisposable[] = [];

	constructor(
		private container: HTMLElement,
		entry: IStatusbarEntry,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IEditorService private readonly editorService: IEditorService,
		@IThemeService private readonly themeService: IThemeService
	) {
		super();

		this.render(entry);
	}

	update(entry: IStatusbarEntry): void {
		clearNode(this.container);
		this.entryDisposables = dispose(this.entryDisposables);

		this.render(entry);
	}

	private render(entry: IStatusbarEntry): void {

		// Text Container
		let textContainer: HTMLElement;
		if (entry.command) {
			textContainer = document.createElement('a');

			this.entryDisposables.push((addDisposableListener(textContainer, 'click', () => this.executeCommand(entry.command!, entry.arguments))));
		} else {
			textContainer = document.createElement('span');
		}

		// Label
		new OcticonLabel(textContainer).text = entry.text;

		// Tooltip
		if (entry.tooltip) {
			textContainer.title = entry.tooltip;
		}

		// Color (only applies to text container)
		this.applyColor(textContainer, entry.color);

		// Background Color (applies to parent element to fully fill container)
		if (entry.backgroundColor) {
			this.applyColor(this.container, entry.backgroundColor, true);
			addClass(this.container, 'has-background-color');
		}

		this.container.appendChild(textContainer);
	}

	private applyColor(container: HTMLElement, color: string | ThemeColor | undefined, isBackground?: boolean): void {
		if (color) {
			if (isThemeColor(color)) {
				const colorId = color.id;
				color = (this.themeService.getTheme().getColor(colorId) || Color.transparent).toString();
				this.entryDisposables.push(((this.themeService.onThemeChange(theme => {
					const colorValue = (theme.getColor(colorId) || Color.transparent).toString();
					isBackground ? container.style.backgroundColor = colorValue : container.style.color = colorValue;
				}))));
			}

			isBackground ? container.style.backgroundColor = color : container.style.color = color;
		}
	}

	private async executeCommand(id: string, args?: unknown[]): Promise<void> {
		args = args || [];

		// Maintain old behaviour of always focusing the editor here
		const activeTextEditorWidget = this.editorService.activeTextEditorWidget;
		if (activeTextEditorWidget) {
			activeTextEditorWidget.focus();
		}

		/* __GDPR__
			"workbenchActionExecuted" : {
				"id" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"from": { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this.telemetryService.publicLog('workbenchActionExecuted', { id, from: 'status bar' });
		try {
			await this.commandService.executeCommand(id, ...args);
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		}
	}

	dispose(): void {
		super.dispose();

		this.entryDisposables = dispose(this.entryDisposables);
	}
}

registerThemingParticipant((theme: ITheme, collector: ICssStyleCollector) => {
	const statusBarItemHoverBackground = theme.getColor(STATUS_BAR_ITEM_HOVER_BACKGROUND);
	if (statusBarItemHoverBackground) {
		collector.addRule(`.monaco-workbench .part.statusbar > .statusbar-item a:hover { background-color: ${statusBarItemHoverBackground}; }`);
	}

	const statusBarItemActiveBackground = theme.getColor(STATUS_BAR_ITEM_ACTIVE_BACKGROUND);
	if (statusBarItemActiveBackground) {
		collector.addRule(`.monaco-workbench .part.statusbar > .statusbar-item a:active { background-color: ${statusBarItemActiveBackground}; }`);
	}

	const statusBarProminentItemForeground = theme.getColor(STATUS_BAR_PROMINENT_ITEM_FOREGROUND);
	if (statusBarProminentItemForeground) {
		collector.addRule(`.monaco-workbench .part.statusbar > .statusbar-item .status-bar-info { color: ${statusBarProminentItemForeground}; }`);
	}

	const statusBarProminentItemBackground = theme.getColor(STATUS_BAR_PROMINENT_ITEM_BACKGROUND);
	if (statusBarProminentItemBackground) {
		collector.addRule(`.monaco-workbench .part.statusbar > .statusbar-item .status-bar-info { background-color: ${statusBarProminentItemBackground}; }`);
	}

	const statusBarProminentItemHoverBackground = theme.getColor(STATUS_BAR_PROMINENT_ITEM_HOVER_BACKGROUND);
	if (statusBarProminentItemHoverBackground) {
		collector.addRule(`.monaco-workbench .part.statusbar > .statusbar-item a.status-bar-info:hover { background-color: ${statusBarProminentItemHoverBackground}; }`);
	}
});

registerSingleton(IStatusbarService, StatusbarPart);