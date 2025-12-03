figma.showUI(__html__, {
  width: 200,
  height: 100,
});

figma.ui.onmessage = async (msg: { type: string }) => {
  if (msg.type === 'send') {
    let selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.notify('No selection found');
      return;
    }

    // Sort selection if all nodes share the same parent to preserve z-order
    let processedSelection: readonly SceneNode[] = selection;
    if (selection.length > 1) {
      const parents = new Set(selection.map(n => n.parent?.id));
      if (parents.size === 1 && selection[0].parent) {
        const parent = selection[0].parent;
        processedSelection = [...selection].sort((a, b) => {
          return parent.children.indexOf(a) - parent.children.indexOf(b);
        });
      }
    }

    // Recursive function to build node data with hierarchy
    const buildNodeData = async (node: SceneNode): Promise<any> => {
      let nodeType = 'unknown';
      if (node.type === 'LINE') nodeType = 'line';
      else if (node.type === 'RECTANGLE') nodeType = 'rectangle';
      else if (node.type === 'ELLIPSE') nodeType = 'ellipse';
      else if (node.type === 'POLYGON') nodeType = 'polygon';
      else if (node.type === 'STAR') nodeType = 'star';
      else if (node.type === 'VECTOR') nodeType = 'vector';
      else if (node.type === 'GROUP') nodeType = 'group';
      else if (node.type === 'FRAME') nodeType = 'frame';
      else if (node.type === 'TEXT') nodeType = 'text';
      else if (node.type === 'BOOLEAN_OPERATION') nodeType = 'boolean';

      const css = await node.getCSSAsync();

      let fillColor = css['background'] || css['background-color'] || css['fill'] || 'none';
      let strokeColor = 'none';
      
      if (css['stroke']) {
        strokeColor = css['stroke'];
      } else if (css['border-color']) {
        strokeColor = css['border-color'];
      } else if (css['border']) {
        const borderParts = css['border'].split(' ');
        if (borderParts.length >= 3 && borderParts[1] === 'solid') {
          strokeColor = borderParts.slice(2).join(' ');
        }
      }

      const data: any = {
        id: node.id,
        name: node.name,
        type: nodeType,
        position: { x: node.x, y: node.y },
        size: { width: node.width, height: node.height },
        rotation: ('rotation' in node) ? (node as any).rotation : 0,
        opacity: ('opacity' in node) ? (node as any).opacity : 1,
        fill: fillColor,
        stroke: strokeColor,
        strokeWeight: ('strokeWeight' in node) ? (node as any).strokeWeight : 0,
        shapeSpecific: {},
        children: []
      };

      // Handle text nodes
      if (node.type === 'TEXT') {
        const textNode = node as TextNode;
        
        // Load the font to ensure we can read all properties
        try {
          await figma.loadFontAsync(textNode.fontName as FontName);
        } catch (e) {
          console.error('Error loading font:', e);
        }
        
        data.shapeSpecific = {
          characters: textNode.characters,
          fontSize: textNode.fontSize,
          fontName: textNode.fontName,
          fontWeight: typeof textNode.fontWeight === 'number' ? textNode.fontWeight : null,
          textAlignHorizontal: textNode.textAlignHorizontal,
          textAlignVertical: textNode.textAlignVertical,
          lineHeight: textNode.lineHeight,
          letterSpacing: textNode.letterSpacing,
          paragraphSpacing: textNode.paragraphSpacing,
          textCase: textNode.textCase,
          textDecoration: textNode.textDecoration,
          textAutoResize: textNode.textAutoResize,
          
          // Check if text has mixed styling
          hasMixedStyling: (
            typeof textNode.fontSize === 'symbol' ||
            typeof textNode.fontName === 'symbol' ||
            typeof textNode.fontWeight === 'symbol'
          ),
          
          // For mixed styling, store character ranges
          styledRanges: []
        };
        
        // If text has mixed styling, extract character-level formatting
        if (data.shapeSpecific.hasMixedStyling) {
          const ranges = [];
          const characters = textNode.characters;
          
          for (let i = 0; i < characters.length; i++) {
            try {
              const charStyle = {
                start: i,
                end: i + 1,
                fontSize: textNode.getRangeFontSize(i, i + 1),
                fontName: textNode.getRangeFontName(i, i + 1),
                fills: textNode.getRangeFills(i, i + 1),
                textDecoration: textNode.getRangeTextDecoration(i, i + 1),
                textCase: textNode.getRangeTextCase(i, i + 1),
                letterSpacing: textNode.getRangeLetterSpacing(i, i + 1),
                lineHeight: textNode.getRangeLineHeight(i, i + 1)
              };
              
              // Merge consecutive characters with same styling
              if (ranges.length > 0) {
                const lastRange = ranges[ranges.length - 1];
                const stylesMatch = JSON.stringify(lastRange.style) === JSON.stringify(charStyle);
                
                if (stylesMatch) {
                  lastRange.end = i + 1;
                  continue;
                }
              }
              
              ranges.push({
                start: i,
                end: i + 1,
                style: charStyle
              });
            } catch (e) {
              console.error('Error reading character style:', e);
            }
          }
          
          data.shapeSpecific.styledRanges = ranges;
        }
      }
      // Handle boolean operations
      else if (node.type === 'BOOLEAN_OPERATION') {
        const booleanNode = node as BooleanOperationNode;
        
        // Store the operation type
        data.shapeSpecific = {
          operation: booleanNode.booleanOperation, // UNION, SUBTRACT, INTERSECT, EXCLUDE
        };
        
        // Flatten the boolean operation to get vector data
        // We need to temporarily flatten it, extract data, then restore
        try {
          const flattened = figma.flatten([booleanNode]);
          
          if (flattened && flattened.type === 'VECTOR') {
            const vectorNode = flattened as VectorNode;
            const paths = [];
            
            for (let i = 0; i < vectorNode.vectorPaths.length; i++) {
              const vectorPath = vectorNode.vectorPaths[i];
              const network = vectorNode.vectorNetwork;
              
              const pathPoints = [];
              const vertices = network.vertices || [];
              const segments = network.segments || [];
              const processedVertices = new Set<number>();
              
              for (const segment of segments) {
                const startIdx = segment.start;
                const endIdx = segment.end;
                
                if (!processedVertices.has(startIdx)) {
                  const vertex = vertices[startIdx];
                  pathPoints.push({
                    x: vertex.x,
                    y: vertex.y,
                    leftHandle: segment.tangentStart ? {
                      x: segment.tangentStart.x,
                      y: segment.tangentStart.y
                    } : null,
                    rightHandle: null,
                    isCorner: vertex.strokeCap !== 'ROUND'
                  });
                  processedVertices.add(startIdx);
                }
                
                if (!processedVertices.has(endIdx)) {
                  const vertex = vertices[endIdx];
                  pathPoints.push({
                    x: vertex.x,
                    y: vertex.y,
                    leftHandle: null,
                    rightHandle: segment.tangentEnd ? {
                      x: segment.tangentEnd.x,
                      y: segment.tangentEnd.y
                    } : null,
                    isCorner: vertex.strokeCap !== 'ROUND'
                  });
                  processedVertices.add(endIdx);
                }
              }
              
              paths.push({
                points: pathPoints,
                closed: vectorPath.windingRule !== 'NONE',
                windingRule: vectorPath.windingRule
              });
            }
            
            data.shapeSpecific.resultVector = {
              paths: paths,
              vectorNetwork: {
                vertices: vectorNode.vectorNetwork.vertices,
                segments: vectorNode.vectorNetwork.segments,
                regions: vectorNode.vectorNetwork.regions
              }
            };
            
            // Remove the flattened node (cleanup)
            flattened.remove();
          }
        } catch (e) {
          console.error('Error flattening boolean operation:', e);
        }
      }
      // Handle vector paths
      else if (node.type === 'VECTOR') {
        const vectorNode = node as VectorNode;
        const paths = [];
        
        // Process each path in the vector network
        for (let i = 0; i < vectorNode.vectorPaths.length; i++) {
          const vectorPath = vectorNode.vectorPaths[i];
          const network = vectorNode.vectorNetwork;
          
          // Extract points from the path
          const pathPoints = [];
          
          // Get the windingRule for the path
          const windingRule = vectorPath.windingRule;
          
          // Process segments to build points array
          if (network && network.segments) {
            // Build a map of which segments belong to this path
            // Note: Figma's vectorNetwork can be complex; we'll extract points from segments
            
            // Get all vertices from the network
            const vertices = network.vertices || [];
            const segments = network.segments || [];
            
            // For simplicity, we'll extract all unique vertices and their handles
            // A more sophisticated approach would trace the actual path
            const processedVertices = new Set<number>();
            
            for (const segment of segments) {
              const startIdx = segment.start;
              const endIdx = segment.end;
              
              if (!processedVertices.has(startIdx)) {
                const vertex = vertices[startIdx];
                pathPoints.push({
                  x: vertex.x,
                  y: vertex.y,
                  leftHandle: segment.tangentStart ? {
                    x: segment.tangentStart.x,
                    y: segment.tangentStart.y
                  } : null,
                  rightHandle: null, // Will be filled from next segment
                  isCorner: vertex.strokeCap !== 'ROUND' // Approximate corner detection
                });
                processedVertices.add(startIdx);
              }
              
              if (!processedVertices.has(endIdx)) {
                const vertex = vertices[endIdx];
                pathPoints.push({
                  x: vertex.x,
                  y: vertex.y,
                  leftHandle: null,
                  rightHandle: segment.tangentEnd ? {
                    x: segment.tangentEnd.x,
                    y: segment.tangentEnd.y
                  } : null,
                  isCorner: vertex.strokeCap !== 'ROUND'
                });
                processedVertices.add(endIdx);
              }
            }
          }
          
          paths.push({
            points: pathPoints,
            closed: vectorPath.windingRule !== 'NONE', // NONZERO or EVENODD means closed
            windingRule: windingRule
          });
        }
        
        data.shapeSpecific = {
          paths: paths,
          vectorNetwork: {
            vertices: vectorNode.vectorNetwork.vertices,
            segments: vectorNode.vectorNetwork.segments,
            regions: vectorNode.vectorNetwork.regions
          }
        };
      }
      // Add shape-specific details for other types
      else if (node.type === 'STAR') {
        data.shapeSpecific = {
          pointCount: node.pointCount,
          innerRadius: node.innerRadius
        };
      } else if (node.type === 'RECTANGLE') {
        data.shapeSpecific = {
          cornerRadius: typeof node.cornerRadius === 'number' ? node.cornerRadius : 0
        };
      } else if (node.type === 'LINE') {
        data.shapeSpecific = {
          strokeCap: node.strokeCap
        };
      } else if (node.type === 'POLYGON') {
        data.shapeSpecific = {
          pointCount: node.pointCount
        };
      }

      // If the node has children (e.g., group, frame), recurse
      if ('children' in node && node.children.length > 0) {
        for (const child of node.children) {
          const childData = await buildNodeData(child);
          data.children.push(childData);
        }
      }

      return data;
    };

    // Build hierarchical data for all selected top-level nodes
    const layers = [];
    for (const node of processedSelection) {
      const nodeData = await buildNodeData(node);
      layers.push(nodeData);
    }

    // Send the data object directly to UI (don't stringify here)
    // The UI will handle stringifying when copying to clipboard
    figma.ui.postMessage({ 
      type: 'copyToClipboard', 
      data: { layers }
    });
  } 
  
  if (msg.type === 'clipboardSuccess') {
    figma.notify('✓ Copied! UXLink will process it automatically');
  }
  
  if (msg.type === 'get') {
    const selection = figma.currentPage.selection;
    figma.notify(`Got: ${selection.length} items selected`);
  }
};