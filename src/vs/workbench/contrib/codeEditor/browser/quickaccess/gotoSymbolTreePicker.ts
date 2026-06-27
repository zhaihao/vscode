/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { LRUCache } from '../../../../../base/common/map.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IRange, Range } from '../../../../../editor/common/core/range.js';
import { ScrollType } from '../../../../../editor/common/editorCommon.js';
import { SymbolKind, SymbolKinds, getAriaLabelForSymbol } from '../../../../../editor/common/languages.js';
import { OutlineElement, OutlineGroup, OutlineModel, TreeElement } from '../../../../../editor/contrib/documentSymbols/browser/outlineModel.js';
import { getCodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IEditor } from '../../../../../editor/common/editorCommon.js';
import { registerAction2, Action2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyMod, KeyCode } from '../../../../../base/common/keyCodes.js';
import { IQuickInputService, IQuickTree, IQuickTreeItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IOutlineModelService } from '../../../../../editor/contrib/documentSymbols/browser/outlineModel.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { overviewRulerRangeHighlight } from '../../../../../editor/common/core/editorColorRegistry.js';
import { themeColorFromId } from '../../../../../platform/theme/common/themeService.js';
import { IModelDeltaDecoration, ITextModel, OverviewRulerLane } from '../../../../../editor/common/model.js';
import { TextEditorSelectionSource } from '../../../../../platform/editor/common/editor.js';
import { accessibilityHelpIsShown, accessibleViewIsShown } from '../../../accessibility/browser/accessibilityConfiguration.js';

/**
 * The default depth up to which the tree is expanded when first opened.
 * Elements deeper than this are collapsed by default.
 */
const DEFAULT_EXPAND_DEPTH = 2;

/**
 * A tree item representing a document symbol in the hierarchical "Go to Symbol" picker.
 */
interface IGotoSymbolTreeItem extends IQuickTreeItem {
	readonly symbolKind: SymbolKind;
	readonly range?: { decoration: IRange; selection: IRange };
	readonly elementId: string;
}

/**
 * A group tree item representing an outline provider group (e.g. when multiple
 * providers contribute symbols). These are non-pickable parent nodes.
 */
interface IGotoSymbolGroupTreeItem extends IQuickTreeItem {
	readonly isGroup: true;
	readonly label: string;
	readonly pickable: false;
	readonly children: readonly IGotoSymbolTreeItem[];
}

/**
 * In-memory store of collapse state per document so the tree picker remembers
 * which nodes the user collapsed/expanded during the current session.
 *
 * Keyed by the document URI. The value maps the outline element id to its
 * collapsed state (true = collapsed). Cleared on application restart.
 */
const symbolTreeCollapseState = new LRUCache<string, Map<string, boolean>>(10);

/**
 * Decorations helper used to highlight the active symbol range while navigating
 * the picker. Mirrors the decoration logic from the flat quick access picker.
 */
class RangeHighlightDecorations implements IDisposable {

	private decorationId: { rangeHighlightId: string; overviewRulerDecorationId: string } | undefined;

	add(editor: IEditor, range: IRange): void {
		editor.changeDecorations(changeAccessor => {
			const deleteDecorations: string[] = [];
			if (this.decorationId) {
				deleteDecorations.push(this.decorationId.overviewRulerDecorationId);
				deleteDecorations.push(this.decorationId.rangeHighlightId);
				this.decorationId = undefined;
			}

			const newDecorations: IModelDeltaDecoration[] = [
				{
					range,
					options: {
						description: 'goto-symbol-tree-range-highlight',
						className: 'rangeHighlight',
						isWholeLine: true
					}
				},
				{
					range,
					options: {
						description: 'goto-symbol-tree-range-highlight-overview',
						overviewRuler: {
							color: themeColorFromId(overviewRulerRangeHighlight),
							position: OverviewRulerLane.Full
						}
					}
				}
			];

			const [rangeHighlightId, overviewRulerDecorationId] = changeAccessor.deltaDecorations(deleteDecorations, newDecorations);
			this.decorationId = { rangeHighlightId, overviewRulerDecorationId };
		});
	}

	clear(editor: IEditor): void {
		const decorationId = this.decorationId;
		if (decorationId) {
			editor.changeDecorations(changeAccessor => {
				changeAccessor.deltaDecorations([
					decorationId.overviewRulerDecorationId,
					decorationId.rangeHighlightId
				], []);
			});
			this.decorationId = undefined;
		}
	}

	dispose(): void {
		this.decorationId = undefined;
	}
}

/**
 * Recursively builds the tree items from the outline model. Honors the
 * remembered collapse state per element; otherwise falls back to the
 * default expand depth.
 */
function buildTreeItems(
	elements: Iterable<TreeElement>,
	collapseState: Map<string, boolean> | undefined,
	depth: number
): IGotoSymbolTreeItem[] {
	const items: IGotoSymbolTreeItem[] = [];

	// The outline model stores children in a Map keyed by id, which preserves
	// insertion order (the order returned by the document symbol provider) but
	// does NOT guarantee ordering by symbol position. Sort by symbol start range
	// so that the tree always reflects the order symbols appear in the document,
	// matching the behavior of the flat picker and the Outline view.
	const sortedElements = [...elements].sort((a, b) => {
		const aRange = a instanceof OutlineElement ? a.symbol.range : undefined;
		const bRange = b instanceof OutlineElement ? b.symbol.range : undefined;
		if (aRange && bRange) {
			return Range.compareRangesUsingStarts(aRange, bRange);
		}
		return 0;
	});

	for (const element of sortedElements) {
		if (element instanceof OutlineElement) {
			const symbol = element.symbol;
			const symbolLabel = symbol.name;
			const hasChildren = element.children.size > 0;

			const children: IGotoSymbolTreeItem[] = hasChildren
				? buildTreeItems(element.children.values(), collapseState, depth + 1)
				: [];

			let collapsed: boolean | undefined;
			if (collapseState?.has(element.id)) {
				collapsed = collapseState.get(element.id);
			} else {
				collapsed = depth >= DEFAULT_EXPAND_DEPTH;
			}

			items.push({
				// The "$(${icon-id}) name" label syntax is rendered inline as an
				// icon + text by the underlying IconLabel (supportIcons: true),
				// matching the behavior of the flat "Go to Symbol" picker.
				label: `$(${SymbolKinds.toIcon(symbol.kind).id}) ${symbolLabel}`,
				ariaLabel: getAriaLabelForSymbol(symbolLabel, symbol.kind),
				description: symbol.detail || undefined,
				symbolKind: symbol.kind,
				range: {
					decoration: symbol.range,
					selection: symbol.selectionRange
				},
				elementId: element.id,
				children: hasChildren ? children : undefined,
				collapsed: hasChildren ? collapsed : undefined
			});
		} else if (element instanceof OutlineGroup) {
			// Group nodes are only rendered when there are multiple providers.
			// In that case they become non-pickable parent nodes.
			const groupChildren = buildTreeItems(element.children.values(), collapseState, depth);

			let collapsed: boolean | undefined;
			if (collapseState?.has(element.id)) {
				collapsed = collapseState.get(element.id);
			} else {
				collapsed = depth >= DEFAULT_EXPAND_DEPTH;
			}

			const groupItem: IGotoSymbolGroupTreeItem = {
				isGroup: true,
				label: element.label,
				pickable: false,
				collapsed,
				children: groupChildren
			};
			items.push(groupItem as unknown as IGotoSymbolTreeItem);
		}
	}

	return items;
}

/**
 * Snapshots the current collapse state of the tree back into the in-memory map
 * so it can be restored the next time the picker is opened for this document.
 */
function snapshotCollapseState(
	picker: IQuickTree<IQuickTreeItem>,
	rootItems: readonly IQuickTreeItem[],
	uriKey: string
): void {
	const state = new Map<string, boolean>();

	const collect = (items: readonly IQuickTreeItem[]): void => {
		for (const item of items) {
			const symbolItem = item as IGotoSymbolTreeItem;
			if (symbolItem.elementId) {
				state.set(symbolItem.elementId, picker.isCollapsed(item));
			}
			if (item.children && item.children.length > 0 && !picker.isCollapsed(item)) {
				collect(item.children);
			}
		}
	};
	collect(rootItems);

	symbolTreeCollapseState.set(uriKey, state);
}

/**
 * Opens the hierarchical "Go to Symbol" tree picker for the active text editor.
 * Returns when the picker is closed.
 */
export async function showGotoSymbolTreePicker(accessor: ServicesAccessor): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const quickInputService = accessor.get(IQuickInputService);
	const outlineModelService = accessor.get(IOutlineModelService);
	const languageFeaturesService = accessor.get(ILanguageFeaturesService);

	const activeEditorPane = editorService.activeEditorPane;
	const control = editorService.activeTextEditorControl;
	const editor = getCodeEditor(control);

	if (!editor || !activeEditorPane) {
		const store = new DisposableStore();
		const picker = store.add(quickInputService.createQuickTree<IQuickTreeItem>());
		picker.placeholder = localize('cannotRunGotoSymbolTreeWithoutEditor', "To go to a symbol, first open a text editor with symbol information.");
		picker.show();
		store.add(picker.onDidHide(() => store.dispose()));
		return;
	}

	const model = editor.getModel();
	if (!model) {
		return;
	}

	const disposables = new DisposableStore();
	const cts = disposables.add(new CancellationTokenSource());

	const decorations = disposables.add(new RangeHighlightDecorations());

	// Resolve the outline model
	const outlineModel: OutlineModel | undefined = await (async () => {
		if (!languageFeaturesService.documentSymbolProvider.has(model)) {
			// Wait for the registry to know the model (mirrors the flat picker behavior)
			const registryPromise = new Promise<boolean>(resolve => {
				if (languageFeaturesService.documentSymbolProvider.has(model)) {
					return resolve(true);
				}
				const listener = disposables.add(languageFeaturesService.documentSymbolProvider.onDidChange(() => {
					if (languageFeaturesService.documentSymbolProvider.has(model)) {
						listener.dispose();
						resolve(true);
					}
				}));
				disposables.add(toDisposable(() => resolve(false)));
			});
			const result = await Promise.race([
				registryPromise,
				new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5000))
			]);
			if (!result || cts.token.isCancellationRequested) {
				return undefined;
			}
		}

		try {
			return await outlineModelService.getOrCreate(model, cts.token);
		} catch {
			return undefined;
		}
	})();

	if (cts.token.isCancellationRequested) {
		disposables.dispose();
		return;
	}

	const uriKey = model.uri.toString();
	const rememberedCollapseState = symbolTreeCollapseState.get(uriKey);

	// Build the tree from the outline model
	let treeItems: readonly IGotoSymbolTreeItem[] = [];
	if (outlineModel && !TreeElement.empty(outlineModel)) {
		treeItems = buildTreeItems(
			outlineModel.children.values(),
			rememberedCollapseState,
			0
		);
	}

	// Create the tree picker
	const picker = disposables.add(quickInputService.createQuickTree<IGotoSymbolTreeItem>());

	picker.placeholder = treeItems.length === 0
		? localize('noSymbolResultsTree', "No editor symbols")
		: localize('gotoSymbolTreePlaceholder', "Type the name of a symbol to go to.");
	picker.matchOnLabel = true;
	picker.matchOnDescription = true;
	picker.sortByLabel = false;
	picker.canSelectMany = false;

	picker.setItemTree([...treeItems]);

	// Navigate when a symbol is accepted
	disposables.add(picker.onDidAccept(() => {
		const [item] = picker.activeItems;
		if (item && item.range && (item as IGotoSymbolTreeItem).symbolKind !== undefined) {
			const symbolItem = item as IGotoSymbolTreeItem;
			gotoLocation(editor, model, symbolItem.range!.selection);

			snapshotCollapseState(picker as IQuickTree<IQuickTreeItem>, treeItems, uriKey);
			picker.hide();
		}
	}));

	// Reveal and decorate the active symbol while navigating
	disposables.add(picker.onDidChangeActive(() => {
		const [item] = picker.activeItems;
		if (item && item.range) {
			const symbolItem = item as IGotoSymbolTreeItem;
			const range = symbolItem.range!;

			// Reveal
			editor.revealRangeInCenter(range.selection, ScrollType.Smooth);

			// Decorate
			decorations.add(editor, range.decoration);

			// Announce
			const lineContent = model.getLineContent(range.selection.startLineNumber);
			status(localize('gotoSymbolTree.status', "Line {0}, column {1}: {2}", range.selection.startLineNumber, range.selection.startColumn, lineContent));
		}
	}));

	// Clean up decorations and snapshot collapse state when the picker hides
	disposables.add(picker.onDidHide(() => {
		decorations.clear(editor);
		snapshotCollapseState(picker as IQuickTree<IQuickTreeItem>, treeItems, uriKey);
		disposables.dispose();
	}));

	// Cancel if the active editor changes while the picker is open
	disposables.add(editorService.onDidActiveEditorChange(() => {
		const newControl = editorService.activeTextEditorControl;
		const newEditor = getCodeEditor(newControl);
		if (newEditor !== editor) {
			cts.cancel();
			picker.hide();
		}
	}));

	picker.show();
}

/**
 * Navigates the editor to the given range. Mirrors the behavior of the flat
 * "Go to Symbol" picker (set selection, reveal, focus, status announcement).
 */
function gotoLocation(editor: IEditor, model: ITextModel, range: IRange): void {
	editor.setSelection(range, TextEditorSelectionSource.JUMP);
	editor.revealRangeInCenter(range, ScrollType.Smooth);
	editor.focus();

	const lineContent = model.getLineContent(range.startLineNumber);
	status(localize('gotoSymbolTree.locationStatus', "Line {0}, column {1}: {2}", range.startLineNumber, range.startColumn, lineContent));
}

class GotoSymbolTreeAction extends Action2 {

	static readonly ID = 'workbench.action.gotoSymbolTree';

	constructor() {
		super({
			id: GotoSymbolTreeAction.ID,
			title: {
				...localize2('gotoSymbolTree', "Go to Symbol in Editor (Tree View)..."),
			},
			f1: true,
			keybinding: {
				when: ContextKeyExpr.and(accessibleViewIsShown.negate(), accessibilityHelpIsShown.negate()),
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.KeyO
			}
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return showGotoSymbolTreePicker(accessor);
	}
}

registerAction2(GotoSymbolTreeAction);
